# Clinic Booking API

A booking API for a clinic plus a small web page that uses it. Built for Task 1 of the Koya Cohort 4 assessment, following the contract at [koyaacademy.com/assessment-api](https://koyaacademy.com/assessment-api).

**Stack:** Node.js, Express, PostgreSQL (`pg`). One service serves both the API and the page.

## What each level does and how

| Level | Requirement | How it's done |
|---|---|---|
| 1 | List slots, book one, look up a booking | `POST /reset`, `GET /slots`, `POST /bookings`, `GET /bookings/{id}`. Slots come back sorted by start time, each with `available`. |
| 2 | API key; reject bad bookings | Every API route checks `X-API-Key` (timing-safe compare) **before** parsing the body, so a keyless request is always `401`. Missing/empty `slot_id`, `name`, `email` or an invalid email → `400`; unknown slot → `404`; slot already started → `400`. Name and email are trimmed; email is lowercased. |
| 3 | No double booking, even at the same instant; cancel | A **partial unique index** (`UNIQUE (slot_id) WHERE status = 'confirmed'`) lets Postgres guarantee one confirmed booking per slot. The insert uses `ON CONFLICT DO NOTHING`, so the loser gets `409`. `DELETE /bookings/{id}` flips `confirmed → cancelled` in one statement (`409` if already cancelled), which frees the slot. |
| 4 | Retries never duplicate; paging | `Idempotency-Key` responses are stored with a hash of the request body. A transaction-scoped advisory lock on the key means simultaneous retries queue up: same body replays the original status and body, different body → `422`. `GET /bookings?email=` pages oldest-first with an opaque cursor (`limit` 1–50, default 10, `next_cursor` is `null` on the last page). |
| 5 | Stop spam | 5 booking attempts per email per sliding minute, stored in Postgres so it survives restarts and multiple instances. Failed attempts count. The 6th gets `429` with `Retry-After` in whole seconds. An advisory lock per email makes the count exact under concurrency. Other emails are unaffected. |

All errors are `{"error": "<message>"}`. Bookings live in Postgres, so they persist across requests and restarts.

### Decisions where the spec was silent

- `available` is `false` only while a slot has a confirmed booking, as the spec defines it. Past slots stay `available: true` but can't be booked (`400`). The web page hides past slots.
- `start`/`end` are returned exactly as sent to `/reset`.
- `GET /bookings` includes cancelled bookings (with `status: "cancelled"`). A missing `email` or a malformed `cursor` returns `400`.
- An idempotent replay doesn't count as a new rate-limit attempt (it books nothing). A `429` isn't stored against the idempotency key, so the client can retry after waiting.
- `POST /reset` also clears stored idempotency keys and rate-limit counters, so each test run starts clean.

## Run locally

```bash
npm install
cp .env.example .env      # then set DATABASE_URL and API_KEY
npm run dev               # http://localhost:3000
npm test                  # runs every level's checks against the server (calls /reset!)
```

The schema is applied automatically on startup (`src/schema.sql`).

## Deploy (free): Neon + Render

1. **Database:** create a free project at [neon.tech](https://neon.tech) and copy the connection string.
2. **Code:** push this folder to a GitHub repo.
3. **Service:** on [render.com](https://render.com) → New → Blueprint → pick the repo (it reads `render.yaml`). Or New → Web Service with build `npm install` and start `npm start`.
4. Set the environment variables `DATABASE_URL` (from Neon) and `API_KEY` (a long random string, e.g. `openssl rand -hex 24`).
5. Once it's live, check it: `BASE_URL=https://<your-app>.onrender.com API_KEY=<key> node test/run.js`.

Render's free tier sleeps after 15 minutes idle and takes about 30–60 seconds to wake on the next request.

## Web page

Open the deployed URL. Paste the API key once (it's kept in the browser), pick an open slot, enter a name and email, and book. The confirmation shows the booking reference, which you can look up on the same page. Each click sends a fresh `Idempotency-Key`, so a network retry can't double-book.

## Endpoints

| Method | Path | Success | Errors |
|---|---|---|---|
| POST | `/reset` | `200` | `400` bad body |
| GET | `/slots?provider=` | `200 {slots:[…]}` | |
| POST | `/bookings` | `201` booking | `400`, `404`, `409`, `422`, `429` |
| GET | `/bookings?email=&limit=&cursor=` | `200 {bookings, next_cursor}` | `400` |
| GET | `/bookings/{id}` | `200` booking | `404` |
| DELETE | `/bookings/{id}` | `200` cancelled booking | `404`, `409` |

All of the above return `401` without a valid `X-API-Key`. `GET /` (the page) and `GET /health` are public.
