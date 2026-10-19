-- Anonymous search counts for "Trending searches".
-- One row per (query, hour, person). `client` is sha256(ip + daily salt), truncated: it can't be
-- reversed to an IP and changes every day, so it only stops one person counting twice.
CREATE TABLE IF NOT EXISTS search_hits (
  q      TEXT    NOT NULL,
  hour   INTEGER NOT NULL,   -- unix time / 3600
  client TEXT    NOT NULL,
  PRIMARY KEY (q, hour, client)
);
CREATE INDEX IF NOT EXISTS search_hits_hour ON search_hits (hour);
