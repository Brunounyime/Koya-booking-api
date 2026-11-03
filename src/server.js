const crypto = require("crypto");
const path = require("path");
const express = require("express");
const { pool, migrate, withTransaction } = require("./db");

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_KEY;
if (!API_KEY) throw new Error("API_KEY is not set. See .env.example.");

const RATE_LIMIT = 5; // booking attempts...
const RATE_WINDOW_SECONDS = 60; // ...per email per minute
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const app = express();
app.disable("x-powered-by");
app.set("trust proxy", true);

// ---------- helpers ----------

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const asyncRoute = (fn) => (req, res, next) => fn(req, res).catch(next);

function bookingJson(row) {
  return {
    id: row.id,
    slot_id: row.slot_id,
    name: row.name,
    email: row.email,
    status: row.status,
    created_at: new Date(row.created_at).toISOString(),
  };
}

const isNonEmptyString = (v) => typeof v === "string" && v.trim().length > 0;

// Stable JSON so {"a":1,"b":2} and {"b":2,"a":1} count as the same body.
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

const sha256 = (s) => crypto.createHash("sha256").update(s).digest("hex");

function safeEqual(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

const encodeCursor = (seq) => Buffer.from(String(seq)).toString("base64url");
function decodeCursor(cursor) {
  const text = Buffer.from(cursor, "base64url").toString("utf8");
  if (!/^\d{1,18}$/.test(text)) throw new HttpError(400, "invalid cursor");
  return text;
}

// ---------- middleware ----------

app.use((req, res, next) => {
  res.set("Access-Control-Allow-Origin", "*");
  res.set(
    "Access-Control-Allow-Headers",
    "Content-Type, X-API-Key, Idempotency-Key",
  );
  res.set("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.set("Access-Control-Expose-Headers", "Retry-After");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

// The web page and a health check are public; everything after this needs the key.
app.use(express.static(path.join(__dirname, "..", "public")));
app.get("/health", (req, res) => res.json({ ok: true }));

// Level 2: checked before the body is even parsed, so a keyless request is always 401.
app.use((req, res, next) => {
  const key = req.get("X-API-Key");
  if (!key || !safeEqual(key, API_KEY)) {
    return res.status(401).json({ error: "missing or invalid API key" });
  }
  next();
});

app.use(express.json({ limit: "1mb" }));

// ---------- Level 1: POST /reset ----------

app.post(
  "/reset",
  asyncRoute(async (req, res) => {
    const slots = req.body && req.body.slots;
    if (!Array.isArray(slots))
      throw new HttpError(400, "slots must be an array");

    const seen = new Set();
    const rows = slots.map((s, i) => {
      if (!s || typeof s !== "object")
        throw new HttpError(400, `slots[${i}] must be an object`);
      for (const f of ["id", "provider", "start", "end"]) {
        if (!isNonEmptyString(s[f]))
          throw new HttpError(400, `slots[${i}].${f} is required`);
      }
      const start = new Date(s.start);
      const end = new Date(s.end);
      if (isNaN(start) || isNaN(end))
        throw new HttpError(400, `slots[${i}] has an invalid date`);
      if (seen.has(s.id)) throw new HttpError(400, `duplicate slot id ${s.id}`);
      seen.add(s.id);
      return [
        s.id,
        s.provider,
        s.start,
        s.end,
        start.toISOString(),
        end.toISOString(),
      ];
    });

    await withTransaction(async (client) => {
      // Serialise resets with bookings so nothing lands half-way through.
      await client.query("LOCK TABLE slots, bookings IN ACCESS EXCLUSIVE MODE");
      await client.query(
        "TRUNCATE bookings, slots, idempotency_keys, booking_attempts RESTART IDENTITY",
      );
      for (const r of rows) {
        await client.query(
          `INSERT INTO slots (id, provider, start_raw, end_raw, start_at, end_at)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          r,
        );
      }
    });

    res.status(200).json({ ok: true, slots: rows.length });
  }),
);

// ---------- Level 1: GET /slots ----------

app.get(
  "/slots",
  asyncRoute(async (req, res) => {
    const { provider } = req.query;
    const params = [];
    let where = "";
    if (typeof provider === "string") {
      params.push(provider);
      where = "WHERE s.provider = $1";
    }
    const { rows } = await pool.query(
      `SELECT s.id, s.provider, s.start_raw, s.end_raw,
              NOT EXISTS (
                SELECT 1 FROM bookings b WHERE b.slot_id = s.id AND b.status = 'confirmed'
              ) AS available
         FROM slots s
         ${where}
        ORDER BY s.start_at, s.id`,
      params,
    );
    res.json({
      slots: rows.map((r) => ({
        id: r.id,
        provider: r.provider,
        start: r.start_raw,
        end: r.end_raw,
        available: r.available,
      })),
    });
  }),
);

// ---------- Levels 1–5: POST /bookings ----------

// Validates and books inside the caller's transaction. Returns { status, body }.
async function bookSlot(client, body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { status: 400, body: { error: "body must be a JSON object" } };
  }
  const { slot_id } = body;
  if (!isNonEmptyString(slot_id))
    return { status: 400, body: { error: "slot_id is required" } };
  if (!isNonEmptyString(body.name))
    return { status: 400, body: { error: "name is required" } };
  if (!isNonEmptyString(body.email))
    return { status: 400, body: { error: "email is required" } };

  const name = body.name.trim();
  const email = body.email.trim().toLowerCase();
  if (!EMAIL_RE.test(email))
    return { status: 400, body: { error: "email is not valid" } };

  const slot = await client.query(
    "SELECT id, start_at <= now() AS started FROM slots WHERE id = $1",
    [slot_id],
  );
  if (slot.rowCount === 0)
    return { status: 404, body: { error: "slot not found" } };
  if (slot.rows[0].started)
    return { status: 400, body: { error: "slot has already started" } };

  // The partial unique index makes this atomic: under any concurrency, only one insert wins.
  const inserted = await client.query(
    `INSERT INTO bookings (id, slot_id, name, email, status)
     VALUES ($1, $2, $3, $4, 'confirmed')
     ON CONFLICT (slot_id) WHERE status = 'confirmed' DO NOTHING
     RETURNING *`,
    [crypto.randomUUID(), slot_id, name, email],
  );
  if (inserted.rowCount === 0)
    return { status: 409, body: { error: "slot is already booked" } };

  return { status: 201, body: bookingJson(inserted.rows[0]) };
}

// Level 5: counts this attempt and reports whether the email is over the limit.
async function checkRateLimit(client, email) {
  // One lock per email so concurrent attempts are counted one at a time.
  await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
    `rate:${email}`,
  ]);
  const { rows } = await client.query(
    `SELECT count(*)::int AS n, min(attempted_at) AS oldest
       FROM booking_attempts
      WHERE email = $1 AND attempted_at > clock_timestamp() - make_interval(secs => $2)`,
    [email, RATE_WINDOW_SECONDS],
  );
  const { n, oldest } = rows[0];
  if (n >= RATE_LIMIT) {
    const freeAt = new Date(oldest).getTime() + RATE_WINDOW_SECONDS * 1000;
    const retryAfter = Math.max(1, Math.ceil((freeAt - Date.now()) / 1000));
    return { limited: true, retryAfter };
  }
  await client.query("INSERT INTO booking_attempts (email) VALUES ($1)", [
    email,
  ]);
  return { limited: false };
}

app.post(
  "/bookings",
  asyncRoute(async (req, res) => {
    const body = req.body;
    const idemKey = req.get("Idempotency-Key");
    const requestHash = sha256(canonical(body === undefined ? null : body));
    const rateEmail =
      body &&
      typeof body === "object" &&
      typeof body.email === "string" &&
      body.email.trim()
        ? body.email.trim().toLowerCase()
        : null;

    const result = await withTransaction(async (client) => {
      // Level 4: a retried request returns the original response and books nothing new.
      if (idemKey) {
        await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
          `idem:${idemKey}`,
        ]);
        const prior = await client.query(
          "SELECT request_hash, status_code, response FROM idempotency_keys WHERE key = $1",
          [idemKey],
        );
        if (prior.rowCount > 0) {
          const p = prior.rows[0];
          if (p.request_hash !== requestHash) {
            return {
              status: 422,
              body: {
                error:
                  "Idempotency-Key was already used with a different request body",
              },
            };
          }
          return { status: p.status_code, body: p.response, replay: true };
        }
      }

      // Level 5: every attempt counts, including ones that fail validation.
      if (rateEmail) {
        const rl = await checkRateLimit(client, rateEmail);
        if (rl.limited) {
          return {
            status: 429,
            body: { error: "too many booking attempts, try again later" },
            retryAfter: rl.retryAfter,
          };
        }
      }

      const outcome = await bookSlot(client, body);

      if (idemKey) {
        await client.query(
          `INSERT INTO idempotency_keys (key, request_hash, status_code, response)
           VALUES ($1, $2, $3, $4)`,
          [idemKey, requestHash, outcome.status, JSON.stringify(outcome.body)],
        );
      }
      return outcome;
    });

    if (result.retryAfter) res.set("Retry-After", String(result.retryAfter));
    if (result.replay) res.set("Idempotent-Replayed", "true");
    res.status(result.status).json(result.body);
  }),
);

// ---------- Level 4: GET /bookings?email= ----------

app.get(
  "/bookings",
  asyncRoute(async (req, res) => {
    const { email, limit, cursor } = req.query;
    if (!isNonEmptyString(email)) throw new HttpError(400, "email is required");

    let pageSize = 10;
    if (limit !== undefined) {
      if (typeof limit !== "string" || !/^\d+$/.test(limit)) {
        throw new HttpError(400, "limit must be an integer between 1 and 50");
      }
      pageSize = Number(limit);
      if (pageSize < 1 || pageSize > 50) {
        throw new HttpError(400, "limit must be an integer between 1 and 50");
      }
    }

    let afterSeq = "0";
    if (cursor !== undefined && cursor !== "") {
      if (typeof cursor !== "string")
        throw new HttpError(400, "invalid cursor");
      afterSeq = decodeCursor(cursor);
    }

    const { rows } = await pool.query(
      `SELECT * FROM bookings
        WHERE email = $1 AND seq > $2
        ORDER BY seq
        LIMIT $3`,
      [email.trim().toLowerCase(), afterSeq, pageSize + 1],
    );

    const hasMore = rows.length > pageSize;
    const page = rows.slice(0, pageSize);
    res.json({
      bookings: page.map(bookingJson),
      next_cursor: hasMore ? encodeCursor(page[page.length - 1].seq) : null,
    });
  }),
);

// ---------- Level 1: GET /bookings/:id ----------

app.get(
  "/bookings/:id",
  asyncRoute(async (req, res) => {
    const { id } = req.params;
    if (!UUID_RE.test(id)) throw new HttpError(404, "booking not found");
    const { rows } = await pool.query("SELECT * FROM bookings WHERE id = $1", [
      id,
    ]);
    if (rows.length === 0) throw new HttpError(404, "booking not found");
    res.json(bookingJson(rows[0]));
  }),
);

// ---------- Level 3: DELETE /bookings/:id ----------

app.delete(
  "/bookings/:id",
  asyncRoute(async (req, res) => {
    const { id } = req.params;
    if (!UUID_RE.test(id)) throw new HttpError(404, "booking not found");

    // Only a confirmed booking can move to cancelled; this frees the slot atomically.
    const updated = await pool.query(
      `UPDATE bookings SET status = 'cancelled'
        WHERE id = $1 AND status = 'confirmed'
        RETURNING *`,
      [id],
    );
    if (updated.rowCount > 0) return res.json(bookingJson(updated.rows[0]));

    const existing = await pool.query("SELECT 1 FROM bookings WHERE id = $1", [
      id,
    ]);
    if (existing.rowCount === 0) throw new HttpError(404, "booking not found");
    throw new HttpError(409, "booking is already cancelled");
  }),
);

// ---------- fallbacks ----------

app.use((req, res) => res.status(404).json({ error: "not found" }));

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err instanceof HttpError)
    return res.status(err.status).json({ error: err.message });
  if (err.type === "entity.parse.failed") {
    return res.status(400).json({ error: "request body is not valid JSON" });
  }
  console.error(err);
  res.status(500).json({ error: "internal server error" });
});

migrate()
  .then(() => {
    app.listen(PORT, () =>
      console.log(`Booking API listening on port ${PORT}`),
    );
  })
  .catch((err) => {
    console.error("Failed to start:", err);
    process.exit(1);
  });
