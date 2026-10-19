-- Sponsor slots bought through the Stripe payment link. A row goes live 48 hours after
-- payment unless the subscription is cancelled first (that cancel is the "block").
CREATE TABLE IF NOT EXISTS sponsors (
  id           TEXT PRIMARY KEY,      -- Stripe checkout session id
  subscription TEXT,                  -- Stripe subscription id
  name         TEXT NOT NULL,
  url          TEXT NOT NULL,
  tagline      TEXT NOT NULL DEFAULT '',
  email        TEXT,
  status       TEXT NOT NULL,         -- ok | unpaid | paused | rejected | canceled
  reason       TEXT,                  -- why the content rules rejected it
  created_at   INTEGER NOT NULL,      -- epoch ms
  live_at      INTEGER NOT NULL       -- epoch ms: created_at + 48 h
);
CREATE INDEX IF NOT EXISTS sponsors_sub ON sponsors(subscription);
