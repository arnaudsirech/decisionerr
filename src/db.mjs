import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

/**
 * `calls` holds one row per CLI invocation, and every daily cap is counted
 * from it, so no separate counter can drift. `decisions` holds one row per
 * request, for audit and dry-run review.
 */
export function openDb(path) {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS decisions (
      id TEXT PRIMARY KEY,
      ts TEXT NOT NULL,
      day TEXT NOT NULL,
      app TEXT NOT NULL,
      task TEXT NOT NULL,
      prompt_hash TEXT NOT NULL,
      input_hash TEXT NOT NULL,
      input_json TEXT NOT NULL,
      output_json TEXT,
      reason TEXT,
      confidence REAL,
      provider TEXT,
      model TEXT,
      latency_ms INTEGER NOT NULL,
      status TEXT NOT NULL,
      error TEXT
    );
    CREATE INDEX IF NOT EXISTS decisions_lookup ON decisions (app, input_hash, ts);
    CREATE INDEX IF NOT EXISTS decisions_task ON decisions (app, task, ts);
    CREATE TABLE IF NOT EXISTS calls (
      id INTEGER PRIMARY KEY,
      ts TEXT NOT NULL,
      day TEXT NOT NULL,
      provider TEXT NOT NULL,
      app TEXT NOT NULL,
      decision_id TEXT NOT NULL,
      ok INTEGER NOT NULL,
      kind TEXT,
      error TEXT,
      model TEXT,
      tokens_in INTEGER,
      tokens_out INTEGER,
      latency_ms INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS calls_day ON calls (day, provider);
    CREATE INDEX IF NOT EXISTS calls_app_day ON calls (day, app);
  `);

  const q = {
    insertDecision: db.prepare(`INSERT INTO decisions
      (id, ts, day, app, task, prompt_hash, input_hash, input_json, output_json,
       reason, confidence, provider, model, latency_ms, status, error)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
    insertCall: db.prepare(`INSERT INTO calls
      (ts, day, provider, app, decision_id, ok, kind, error, model, tokens_in, tokens_out, latency_ms)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
    providerCalls: db.prepare("SELECT COUNT(*) AS n FROM calls WHERE day = ? AND provider = ?"),
    appCalls: db.prepare("SELECT COUNT(*) AS n FROM calls WHERE day = ? AND app = ?"),
    cached: db.prepare(`SELECT * FROM decisions
      WHERE app = ? AND input_hash = ? AND status = 'ok' AND ts >= ?
      ORDER BY ts DESC LIMIT 1`),
    list: db.prepare(`SELECT * FROM decisions
      WHERE app = ? AND (? IS NULL OR task = ?) AND ts >= ?
      ORDER BY ts DESC LIMIT ?`),
  };

  return {
    insertDecision: (d) =>
      q.insertDecision.run(
        d.id, d.ts, d.day, d.app, d.task, d.promptHash, d.inputHash, d.inputJson,
        d.outputJson ?? null, d.reason ?? null, d.confidence ?? null, d.provider ?? null,
        d.model ?? null, d.latencyMs, d.status, d.error ?? null,
      ),
    insertCall: (c) =>
      q.insertCall.run(
        c.ts, c.day, c.provider, c.app, c.decisionId, c.ok ? 1 : 0, c.kind ?? null,
        c.error ?? null, c.model ?? null, c.tokensIn ?? null, c.tokensOut ?? null, c.latencyMs,
      ),
    providerCalls: (day, provider) => q.providerCalls.get(day, provider).n,
    appCalls: (day, app) => q.appCalls.get(day, app).n,
    findCached: (app, inputHash, sinceIso) => q.cached.get(app, inputHash, sinceIso) ?? null,
    listDecisions: ({ app, task = null, since, limit }) => q.list.all(app, task, task, since, limit),
    close: () => db.close(),
  };
}
