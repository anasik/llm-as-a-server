// D1 access. This module knows about sessions, an opaque string, a version
// number and two generic counters. It never parses `state_json`.
import { LIMITS } from "./limits";

export interface SessionRow {
  stateJson: string;
  version: number;
  createdAt: number;
  updatedAt: number;
}

export type SaveOutcome = "ok" | "conflict" | "failed";

export async function loadOrCreateSession(
  db: D1Database,
  sessionId: string,
  now: number,
): Promise<SessionRow> {
  await db
    .prepare(
      `INSERT INTO sessions (session_id, state_json, version, created_at, updated_at)
       VALUES (?1, 'null', 0, ?2, ?2)
       ON CONFLICT(session_id) DO NOTHING`,
    )
    .bind(sessionId, now)
    .run();

  const row = await db
    .prepare(`SELECT state_json, version, created_at, updated_at FROM sessions WHERE session_id = ?1`)
    .bind(sessionId)
    .first<{ state_json: string; version: number; created_at: number; updated_at: number }>();

  if (!row) throw new Error("session_row_missing_after_insert");
  return {
    stateJson: row.state_json,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// Optimistic concurrency: the update only lands if the version we read is still
// the version stored. A stale writer gets `conflict` and must retry; it never
// overwrites newer state.
export async function saveState(
  db: D1Database,
  sessionId: string,
  nextStateJson: string,
  expectedVersion: number,
  now: number,
): Promise<SaveOutcome> {
  try {
    const result = await db
      .prepare(
        `UPDATE sessions
            SET state_json = ?1, version = version + 1, updated_at = ?2
          WHERE session_id = ?3 AND version = ?4`,
      )
      .bind(nextStateJson, now, sessionId, expectedVersion)
      .run();
    const changed = result.meta?.changes ?? 0;
    return changed === 1 ? "ok" : "conflict";
  } catch {
    return "failed";
  }
}

export async function resetSessionState(db: D1Database, sessionId: string, now: number): Promise<void> {
  await db
    .prepare(
      `INSERT INTO sessions (session_id, state_json, version, created_at, updated_at)
       VALUES (?1, 'null', 0, ?2, ?2)
       ON CONFLICT(session_id) DO UPDATE
         SET state_json = 'null', version = sessions.version + 1, updated_at = ?2`,
    )
    .bind(sessionId, now)
    .run();
}

export interface ThrottleDecision {
  allowed: boolean;
  scope: "session" | "global" | null;
  retryAfterSeconds: number;
  sessionCount: number;
  globalCount: number;
}

async function bump(
  db: D1Database,
  table: "runtime_throttle" | "runtime_counters",
  key: string,
  now: number,
): Promise<{ count: number; windowStart: number }> {
  const windowStart = now - (now % LIMITS.throttleWindowMs);
  const sql =
    table === "runtime_throttle"
      ? `INSERT INTO runtime_throttle (session_id, window_start, count) VALUES (?1, ?2, 1)
           ON CONFLICT(session_id) DO UPDATE
             SET count = CASE WHEN runtime_throttle.window_start < ?2 THEN 1 ELSE runtime_throttle.count + 1 END,
                 window_start = ?2
           RETURNING count, window_start`
      : `INSERT INTO runtime_counters (name, window_start, value) VALUES (?1, ?2, 1)
           ON CONFLICT(name) DO UPDATE
             SET value = CASE WHEN runtime_counters.window_start < ?2 THEN 1 ELSE runtime_counters.value + 1 END,
                 window_start = ?2
           RETURNING value AS count, window_start`;
  const row = await db.prepare(sql).bind(key, windowStart).first<{ count: number; window_start: number }>();
  return { count: row?.count ?? 1, windowStart: row?.window_start ?? windowStart };
}

export async function consumeQuota(db: D1Database, sessionId: string, now: number): Promise<ThrottleDecision> {
  const session = await bump(db, "runtime_throttle", sessionId, now);
  const global = await bump(db, "runtime_counters", "global_requests", now);
  const retryAfterSeconds = Math.max(
    1,
    Math.ceil((session.windowStart + LIMITS.throttleWindowMs - now) / 1000),
  );

  if (session.count > LIMITS.throttlePerSessionPerWindow) {
    return { allowed: false, scope: "session", retryAfterSeconds, sessionCount: session.count, globalCount: global.count };
  }
  if (global.count > LIMITS.globalPerWindow) {
    return { allowed: false, scope: "global", retryAfterSeconds, sessionCount: session.count, globalCount: global.count };
  }
  return { allowed: true, scope: null, retryAfterSeconds: 0, sessionCount: session.count, globalCount: global.count };
}
