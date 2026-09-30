import { timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { openDb } from "./db.mjs";
import { createDecider } from "./decide.mjs";
import { agyProvider } from "./providers/agy.mjs";
import { claudeProvider } from "./providers/claude.mjs";

const MAX_BODY_BYTES = 8 * 1024 * 1024;
const MEDIA_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);
const TIERS = new Set(["fast", "thorough"]);

function send(response, status, body) {
  response.writeHead(status, { "Content-Type": "application/json" });
  response.end(JSON.stringify(body));
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("too_large"));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

/** `apps` maps an app name to `{ token, dailyCap }`; the token decides the app. */
function appFor(apps, header) {
  const given = Buffer.from(String(header ?? "").replace(/^Bearer\s+/i, ""));
  let found = null;
  for (const [name, { token }] of Object.entries(apps)) {
    const expected = Buffer.from(token);
    if (given.length === expected.length && timingSafeEqual(given, expected)) found = name;
  }
  return found;
}

/** Returns the normalised request, or a string saying what is wrong. */
export function parseRequest(body) {
  if (!body || typeof body !== "object") return "body must be an object";
  const { task = "default", system, input, schema, tier = "fast", images = [], cache_ttl_s = 0 } = body;
  if (typeof task !== "string" || !/^[\w.-]{1,64}$/.test(task)) return "task: 1-64 chars [A-Za-z0-9_.-]";
  if (typeof system !== "string" || !system.trim() || system.length > 20_000) return "system: non-empty string up to 20000 chars";
  if (input === undefined) return "input is required";
  if (JSON.stringify(input).length > 200_000) return "input: up to 200000 chars once serialised";
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return "schema must be a JSON Schema object";
  if (!TIERS.has(tier)) return "tier: fast | thorough";
  if (!Number.isInteger(cache_ttl_s) || cache_ttl_s < 0 || cache_ttl_s > 7 * 86_400) return "cache_ttl_s: integer 0-604800";
  if (!Array.isArray(images) || images.length > 4) return "images: array of up to 4";
  for (const image of images) {
    if (!MEDIA_TYPES.has(image?.media_type) || typeof image?.data !== "string") {
      return "images[]: { media_type: image/jpeg|png|webp|gif, data: base64 }";
    }
  }
  return { task, system, input, schema, tier, images, cacheTtlS: cache_ttl_s };
}

export function createApp({ decider, db, apps }) {
  return createServer(async (request, response) => {
    const url = new URL(request.url, "http://localhost");
    try {
      if (request.method === "GET" && url.pathname === "/healthz") {
        return send(response, 200, { ok: true, ...decider.status() });
      }

      const app = appFor(apps, request.headers.authorization);
      if (url.pathname === "/v1/decide" || url.pathname === "/v1/decisions") {
        if (!app) return send(response, 401, { error: "unauthorised" });
      } else {
        return send(response, 404, { error: "not_found" });
      }

      if (request.method === "GET" && url.pathname === "/v1/decisions") {
        const since = url.searchParams.get("since") ?? new Date(Date.now() - 86_400_000).toISOString();
        const limit = Math.min(Number(url.searchParams.get("limit") ?? 100) || 100, 1000);
        const rows = db.listDecisions({ app, task: url.searchParams.get("task"), since, limit });
        return send(response, 200, { decisions: rows });
      }

      if (request.method === "POST" && url.pathname === "/v1/decide") {
        let body;
        try {
          body = JSON.parse(await readBody(request));
        } catch (error) {
          const tooLarge = error instanceof Error && error.message === "too_large";
          return send(response, tooLarge ? 413 : 400, { error: tooLarge ? "too_large" : "bad_json" });
        }
        const parsed = parseRequest(body);
        if (typeof parsed === "string") return send(response, 400, { error: "bad_request", detail: parsed });
        const outcome = await decider.decide(app, parsed);
        const tag = outcome.status === 200 ? `${outcome.body.provider}${outcome.body.cached ? " cached" : ""}` : outcome.body.error;
        console.log(`${app} ${parsed.task} ${outcome.status} ${tag}`);
        return send(response, outcome.status, outcome.body);
      }

      return send(response, 405, { error: "method_not_allowed" });
    } catch (error) {
      console.error(error);
      return send(response, 500, { error: "internal" });
    }
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const env = process.env;
  const home = env.HOME ?? "/tmp";
  const appsPath = env.DECISIONERR_APPS ?? join(home, "decisionerr", "apps.json");
  const apps = JSON.parse(readFileSync(appsPath, "utf8"));
  for (const [name, app] of Object.entries(apps)) {
    if (!/^[0-9a-f]{64}$/.test(app.token ?? "")) throw new Error(`${name}: token must be 64 hex chars`);
    if (!Number.isInteger(app.dailyCap)) throw new Error(`${name}: dailyCap must be an integer`);
  }
  const db = openDb(env.DECISIONERR_DB ?? join(home, "decisionerr", "data", "decisions.db"));
  const decider = createDecider({
    db,
    apps,
    maxConcurrent: Number(env.DECISIONERR_CONCURRENCY ?? 2),
    providers: [
      {
        provider: claudeProvider({ bin: env.CLAUDE_BIN ?? "claude" }),
        dailyCap: Number(env.CLAUDE_DAILY_CAP ?? 100),
      },
      {
        provider: agyProvider({ bin: env.AGY_BIN ?? "agy", model: env.AGY_MODEL || null }),
        dailyCap: Number(env.AGY_DAILY_CAP ?? 50),
      },
    ],
  });
  const port = Number(env.DECISIONERR_PORT ?? 8790);
  const host = env.DECISIONERR_HOST ?? "127.0.0.1";
  createApp({ decider, db, apps }).listen(port, host, () => {
    console.log(`decisionerr on ${host}:${port}, apps: ${Object.keys(apps).join(", ")}`);
  });
}
