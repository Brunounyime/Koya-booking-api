-- Applied automatically on startup. Safe to run more than once.

CREATE TABLE IF NOT EXISTS slots (
  id          TEXT PRIMARY KEY,
  provider    TEXT NOT NULL,
  start_raw   TEXT NOT NULL,          -- exactly as sent to /reset, returned as-is
  end_raw     TEXT NOT NULL,
  start_at    TIMESTAMPTZ NOT NULL,   -- parsed, used for ordering and "already started"
  end_at      TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS bookings (
  seq         BIGSERIAL UNIQUE,       -- insertion order, used as the pagination cursor
  id          UUID PRIMARY KEY,
  slot_id     TEXT NOT NULL REFERENCES slots(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  email       TEXT NOT NULL,
  status      TEXT NOT NULL CHECK (status IN ('confirmed', 'cancelled')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

-- Level 3: the database itself guarantees at most one confirmed booking per slot,
-- so two simultaneous requests can never both win.
CREATE UNIQUE INDEX IF NOT EXISTS one_confirmed_booking_per_slot
  ON bookings (slot_id) WHERE status = 'confirmed';

-- Level 4: oldest-first pagination per person.
CREATE INDEX IF NOT EXISTS bookings_by_email
  ON bookings (email, seq);

-- Level 4: stored responses for Idempotency-Key replays.
CREATE TABLE IF NOT EXISTS idempotency_keys (
  key           TEXT PRIMARY KEY,
  request_hash  TEXT NOT NULL,
  status_code   INT  NOT NULL,
  response      JSONB NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Level 5: one row per booking attempt, used for the per-email rate limit.
CREATE TABLE IF NOT EXISTS booking_attempts (
  id           BIGSERIAL PRIMARY KEY,
  email        TEXT NOT NULL,
  attempted_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX IF NOT EXISTS booking_attempts_by_email
  ON booking_attempts (email, attempted_at);
