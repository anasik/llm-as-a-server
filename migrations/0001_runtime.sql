-- Generic runtime storage only.
-- There is deliberately no table, column or index describing any application
-- concept (no pages, routes, notes, users, products, files). The website's
-- entire domain model lives inside the opaque `state_json` document, which
-- this layer never parses.

CREATE TABLE IF NOT EXISTS sessions (
  session_id TEXT PRIMARY KEY,
  state_json TEXT NOT NULL,
  version    INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Generic per-session throttling window.
CREATE TABLE IF NOT EXISTS runtime_throttle (
  session_id   TEXT PRIMARY KEY,
  window_start INTEGER NOT NULL,
  count        INTEGER NOT NULL
);

-- Generic named counters (global request ceiling, etc).
CREATE TABLE IF NOT EXISTS runtime_counters (
  name         TEXT PRIMARY KEY,
  window_start INTEGER NOT NULL,
  value        INTEGER NOT NULL
);
