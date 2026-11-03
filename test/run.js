const BASE = (process.env.BASE_URL || "http://localhost:3000").replace(
  /\/$/,
  "",
);
const KEY = process.env.API_KEY;
if (!KEY) throw new Error("Set API_KEY");

let passed = 0;
let failed = 0;
function check(name, cond, extra) {
  if (cond) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    console.log(
      `  ✗ ${name}`,
      extra !== undefined ? JSON.stringify(extra) : "",
    );
  }
}

async function call(method, path, { body, key = KEY, headers = {}, raw } = {}) {
  const h = { ...headers };
  if (key !== null) h["X-API-Key"] = key;
  if (body !== undefined || raw !== undefined)
    h["Content-Type"] = "application/json";
  const res = await fetch(BASE + path, {
    method,
    headers: h,
    body:
      raw !== undefined
        ? raw
        : body !== undefined
          ? JSON.stringify(body)
          : undefined,
  });
  let json = null;
  try {
    json = await res.json();
  } catch {}
  return { status: res.status, body: json, headers: res.headers };
}

const iso = (minutesFromNow) =>
  new Date(Date.now() + minutesFromNow * 60000)
    .toISOString()
    .replace(".000", "");
let n = 0;
const uniqueEmail = () => `user${Date.now()}${n++}@example.com`;
const book = (slot_id, email = uniqueEmail(), extra = {}) =>
  call("POST", "/bookings", {
    body: { slot_id, name: "Test Person", email },
    ...extra,
  });

(async () => {
  console.log(`Testing ${BASE}\n`);

  const slots = [
    { id: "s3", provider: "Dr Ade", start: iso(2 * 60), end: iso(2 * 60 + 30) },
    { id: "s1", provider: "Dr Ade", start: iso(60), end: iso(90) },
    { id: "s2", provider: "Dr Bisi", start: iso(90), end: iso(120) },
    { id: "past", provider: "Dr Ade", start: iso(-60), end: iso(-30) },
  ];
  for (let i = 0; i < 10; i++) {
    slots.push({
      id: `p${i}`,
      provider: "Dr Page",
      start: iso(300 + i * 30),
      end: iso(330 + i * 30),
    });
  }

  console.log("Level 2 — API key");
  check(
    "no key → 401",
    (await call("GET", "/slots", { key: null })).status === 401,
  );
  check(
    "wrong key → 401",
    (await call("GET", "/slots", { key: "nope" })).status === 401,
  );
  const bad = await call("POST", "/bookings", { key: null, raw: "{not json" });
  check("no key + bad JSON → 401 (key checked first)", bad.status === 401, bad);
  check("401 body is {error}", typeof bad.body.error === "string");

  console.log("Level 1 — reset, slots, book, look up");
  const reset = await call("POST", "/reset", { body: { slots } });
  check("POST /reset → 200", reset.status === 200, reset);
  const list = await call("GET", "/slots");
  check(
    "GET /slots → 200 with {slots}",
    list.status === 200 && Array.isArray(list.body.slots),
    list,
  );
  const ids = list.body.slots.map((s) => s.id);
  check(
    "slots sorted by start",
    ids.slice(0, 4).join() === "past,s1,s2,s3",
    ids,
  );
  check(
    "all available after reset",
    list.body.slots.every((s) => s.available === true),
  );
  check(
    "start returned exactly as sent",
    list.body.slots.find((s) => s.id === "s1").start === slots[1].start,
  );
  const filtered = await call("GET", "/slots?provider=Dr%20Bisi");
  check(
    "provider filter",
    filtered.body.slots.length === 1 && filtered.body.slots[0].id === "s2",
    filtered.body,
  );

  const b1 = await call("POST", "/bookings", {
    body: { slot_id: "s1", name: "  Ada Obi  ", email: "  ADA@Example.com " },
  });
  check("book → 201", b1.status === 201, b1);
  check(
    "name trimmed, email trimmed+lowercased",
    b1.body.name === "Ada Obi" && b1.body.email === "ada@example.com",
    b1.body,
  );
  check(
    "booking has all fields",
    ["id", "slot_id", "name", "email", "status", "created_at"].every(
      (f) => f in b1.body,
    ),
  );
  check("status confirmed", b1.body.status === "confirmed");
  const got = await call("GET", `/bookings/${b1.body.id}`);
  check(
    "GET /bookings/{id} → 200",
    got.status === 200 && got.body.id === b1.body.id,
    got,
  );
  check(
    "unknown booking → 404",
    (await call("GET", "/bookings/00000000-0000-0000-0000-000000000000"))
      .status === 404,
  );
  check(
    "non-uuid booking id → 404",
    (await call("GET", "/bookings/abc")).status === 404,
  );
  const afterBook = await call("GET", "/slots");
  check(
    "booked slot shows available:false",
    afterBook.body.slots.find((s) => s.id === "s1").available === false,
  );

  console.log("Level 2 — validation");
  const missing = [
    { name: "x", email: uniqueEmail() },
    { slot_id: "s3", email: uniqueEmail() },
    { slot_id: "s3", name: "x" },
    { slot_id: "", name: "x", email: uniqueEmail() },
    { slot_id: "s3", name: "   ", email: uniqueEmail() },
  ];
  for (const body of missing) {
    const r = await call("POST", "/bookings", { body });
    check(
      `missing/empty field → 400 ${JSON.stringify(Object.keys(body))}`,
      r.status === 400 && r.body.error,
      r,
    );
  }
  const badEmail = await call("POST", "/bookings", {
    body: { slot_id: "s3", name: "x", email: "not-an-email" },
  });
  check("invalid email → 400", badEmail.status === 400, badEmail);
  check("unknown slot → 404", (await book("nope")).status === 404);
  check("past slot → 400", (await book("past")).status === 400);
  check(
    "invalid JSON → 400",
    (await call("POST", "/bookings", { raw: "{oops" })).status === 400,
  );

  console.log("Level 3 — no double booking, cancel");
  check("second booking of same slot → 409", (await book("s1")).status === 409);
  const race = await Promise.all(Array.from({ length: 25 }, () => book("s2")));
  const wins = race.filter((r) => r.status === 201).length;
  const conflicts = race.filter((r) => r.status === 409).length;
  check(
    `25 simultaneous bookings → exactly 1 succeeds (got ${wins} × 201, ${conflicts} × 409)`,
    wins === 1 && conflicts === 24,
  );

  const del = await call("DELETE", `/bookings/${b1.body.id}`);
  check(
    "DELETE → 200 with status cancelled",
    del.status === 200 && del.body.status === "cancelled",
    del,
  );
  check(
    "DELETE again → 409",
    (await call("DELETE", `/bookings/${b1.body.id}`)).status === 409,
  );
  check(
    "DELETE unknown → 404",
    (await call("DELETE", "/bookings/00000000-0000-0000-0000-000000000000"))
      .status === 404,
  );
  const freed = await call("GET", "/slots");
  check(
    "cancelled slot is available again",
    freed.body.slots.find((s) => s.id === "s1").available === true,
  );
  check("cancelled slot can be rebooked", (await book("s1")).status === 201);

  console.log("Level 4 — idempotency, pagination");
  const idemKey = `k-${Date.now()}`;
  const idemEmail = uniqueEmail();
  const first = await book("s3", idemEmail, {
    headers: { "Idempotency-Key": idemKey },
  });
  const retry = await book("s3", idemEmail, {
    headers: { "Idempotency-Key": idemKey },
  });
  check("first request → 201", first.status === 201, first);
  check(
    "retry → same status and same booking",
    retry.status === 201 && retry.body.id === first.body.id,
    retry,
  );
  const mine = await call(
    "GET",
    `/bookings?email=${encodeURIComponent(idemEmail)}`,
  );
  check("only one booking exists", mine.body.bookings.length === 1, mine.body);
  const changed = await call("POST", "/bookings", {
    body: { slot_id: "s3", name: "Someone Else", email: idemEmail },
    headers: { "Idempotency-Key": idemKey },
  });
  check("same key, different body → 422", changed.status === 422, changed);

  const raceKey = `race-${Date.now()}`;
  const raceEmail = uniqueEmail();
  const idemRace = await Promise.all(
    Array.from({ length: 10 }, () =>
      book("p9", raceEmail, { headers: { "Idempotency-Key": raceKey } }),
    ),
  );
  const raceIds = new Set(idemRace.map((r) => r.body && r.body.id));
  check(
    "10 simultaneous retries → one booking, same response",
    idemRace.every((r) => r.status === 201) && raceIds.size === 1,
    idemRace.map((r) => r.status),
  );

  const pager = uniqueEmail();
  for (let i = 0; i < 5; i++) {
    const r = await book(`p${i}`, pager);
    if (r.status !== 201) console.log("    setup booking failed", r);
  }
  const p1 = await call(
    "GET",
    `/bookings?email=${encodeURIComponent(pager)}&limit=2`,
  );
  check(
    "page 1 has 2 + next_cursor",
    p1.body.bookings.length === 2 && typeof p1.body.next_cursor === "string",
    p1.body,
  );
  const p2 = await call(
    "GET",
    `/bookings?email=${encodeURIComponent(pager)}&limit=2&cursor=${p1.body.next_cursor}`,
  );
  const p3 = await call(
    "GET",
    `/bookings?email=${encodeURIComponent(pager)}&limit=2&cursor=${p2.body.next_cursor}`,
  );
  check(
    "page 3 has 1 and next_cursor null",
    p3.body.bookings.length === 1 && p3.body.next_cursor === null,
    p3.body,
  );
  const all = [
    ...p1.body.bookings,
    ...p2.body.bookings,
    ...p3.body.bookings,
  ].map((b) => b.slot_id);
  check(
    "oldest first, no gaps or repeats",
    all.join() === "p0,p1,p2,p3,p4",
    all,
  );
  const def = await call(
    "GET",
    `/bookings?email=${encodeURIComponent(pager.toUpperCase())}`,
  );
  check(
    "default limit, email case-insensitive",
    def.body.bookings.length === 5 && def.body.next_cursor === null,
    def.body,
  );
  for (const l of ["0", "51", "abc", "2.5"]) {
    check(
      `limit=${l} → 400`,
      (await call("GET", `/bookings?email=${pager}&limit=${l}`)).status === 400,
    );
  }
  check("missing email → 400", (await call("GET", "/bookings")).status === 400);

  console.log("Level 5 — rate limit");
  const spammer = uniqueEmail();
  const attempts = [];
  for (let i = 0; i < 6; i++) attempts.push(await book("nope", spammer)); // failures still count
  check(
    "first 5 attempts processed (404s)",
    attempts.slice(0, 5).every((r) => r.status === 404),
    attempts.map((r) => r.status),
  );
  check("6th attempt → 429", attempts[5].status === 429, attempts[5]);
  const ra = Number(attempts[5].headers.get("retry-after"));
  check(
    `Retry-After is whole seconds (${ra})`,
    Number.isInteger(ra) && ra >= 1 && ra <= 60,
  );
  check("other emails unaffected", (await book("p5")).status === 201);
  const burst = uniqueEmail();
  const burstRes = await Promise.all(
    Array.from({ length: 12 }, () => book("nope", burst)),
  );
  const limited = burstRes.filter((r) => r.status === 429).length;
  check(
    `12 simultaneous attempts → exactly 7 limited (got ${limited})`,
    limited === 7,
  );

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
