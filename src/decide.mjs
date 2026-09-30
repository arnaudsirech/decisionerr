import { createHash, randomBytes } from "node:crypto";
import { ENVELOPE_INSTRUCTIONS, envelope, validatorFor } from "./envelope.mjs";

const sha256 = (text) => createHash("sha256").update(text).digest("hex");

/** How long a provider is skipped after a failure of each kind. */
const BREAKER_MS = {
  limit: 30 * 60_000,
  auth: 60 * 60_000,
  transient: 5 * 60_000,
};

export const localDay = (date) => date.toLocaleDateString("sv-SE");

function msUntilMidnight(now) {
  const next = new Date(now);
  next.setHours(24, 0, 0, 0);
  return next - now;
}

/** At most `limit` provider runs at once; later requests wait in line. */
function semaphore(limit, maxQueue) {
  let running = 0;
  const queue = [];
  const release = () => {
    running -= 1;
    const next = queue.shift();
    if (next) {
      running += 1;
      next();
    }
  };
  return {
    stats: () => ({ running, queued: queue.length }),
    async acquire() {
      if (running < limit) {
        running += 1;
        return release;
      }
      if (queue.length >= maxQueue) return null;
      await new Promise((resolve) => queue.push(resolve));
      return release;
    },
  };
}

/**
 * `providers` is the fallback chain, each `{ provider, dailyCap }`.
 * `apps` maps an app name to `{ dailyCap }`.
 */
export function createDecider({
  db,
  providers,
  apps,
  now = () => new Date(),
  maxConcurrent = 2,
  maxQueue = 20,
  log = console,
}) {
  const breakers = new Map();
  const gate = semaphore(maxConcurrent, maxQueue);

  function status() {
    const today = localDay(now());
    return {
      providers: providers.map(({ provider, dailyCap }) => ({
        name: provider.name,
        usedToday: db.providerCalls(today, provider.name),
        dailyCap,
        downUntil: breakers.get(provider.name)?.until ?? null,
        downReason: breakers.get(provider.name)?.reason ?? null,
      })),
      ...gate.stats(),
    };
  }

  function trip(name, result) {
    const ms = BREAKER_MS[result.kind];
    if (!ms) return;
    const until = result.retryAt && result.retryAt > now().getTime()
      ? new Date(result.retryAt)
      : new Date(now().getTime() + ms);
    breakers.set(name, { until: until.toISOString(), reason: `${result.kind}: ${result.error}` });
    const line = `provider ${name} down until ${until.toISOString()} (${result.kind}: ${result.error})`;
    if (result.kind === "auth") log.error(`!!! ${line} — log in again on the server`);
    else log.warn(line);
  }

  async function decide(app, request) {
    const started = now();
    const today = localDay(started);
    const { task, system, input, schema, tier, images, cacheTtlS } = request;
    const id = `dec_${randomBytes(9).toString("base64url")}`;
    const schemaKey = sha256(JSON.stringify(schema));
    const envelopeSchema = envelope(schema);
    let validate;
    try {
      validate = validatorFor(schemaKey, envelopeSchema);
    } catch (error) {
      return { status: 400, body: { error: "bad_schema", detail: error.message } };
    }
    const promptHash = sha256(system);
    const inputJson = JSON.stringify(input);
    const inputHash = sha256(
      JSON.stringify([system, inputJson, schemaKey, tier, images.map((i) => sha256(i.data))]),
    );
    const record = (fields) =>
      db.insertDecision({
        id, ts: started.toISOString(), day: today, app, task, promptHash, inputHash,
        inputJson: images.length ? JSON.stringify({ input, images: images.length }) : inputJson,
        latencyMs: now() - started, ...fields,
      });

    if (cacheTtlS > 0) {
      const since = new Date(started.getTime() - cacheTtlS * 1000).toISOString();
      const hit = db.findCached(app, inputHash, since);
      if (hit) {
        record({
          outputJson: hit.output_json, reason: hit.reason, confidence: hit.confidence,
          provider: hit.provider, model: hit.model, status: "cached",
        });
        return {
          status: 200,
          body: {
            id, decision: JSON.parse(hit.output_json), reason: hit.reason,
            confidence: hit.confidence, provider: hit.provider, model: hit.model,
            cached: true, latency_ms: now() - started,
          },
        };
      }
    }

    const appCap = apps[app]?.dailyCap ?? 0;
    if (db.appCalls(today, app) >= appCap) {
      record({ status: "capped", error: `app daily cap ${appCap}` });
      return {
        status: 429,
        body: { error: "app_cap", retry_after: Math.ceil(msUntilMidnight(started) / 1000) },
      };
    }

    const release = await gate.acquire();
    if (!release) {
      record({ status: "unavailable", error: "queue full" });
      return { status: 503, body: { error: "busy", retry_after: 30 } };
    }

    const fullSystem = `${system}\n\n${ENVELOPE_INSTRUCTIONS}`;
    const prompt = `<input>\n${typeof input === "string" ? input : JSON.stringify(input, null, 2)}\n</input>`;
    const skipped = [];
    let sawInvalid = false;
    let retryAt = Infinity;

    try {
      for (const { provider, dailyCap } of providers) {
        const at = now();
        const breaker = breakers.get(provider.name);
        if (breaker && new Date(breaker.until) > at) {
          skipped.push(`${provider.name}: down`);
          retryAt = Math.min(retryAt, new Date(breaker.until).getTime());
          continue;
        }
        if (images.length && !provider.supportsImages) {
          skipped.push(`${provider.name}: no images`);
          continue;
        }
        if (db.providerCalls(localDay(at), provider.name) >= dailyCap) {
          skipped.push(`${provider.name}: daily cap ${dailyCap}`);
          retryAt = Math.min(retryAt, at.getTime() + msUntilMidnight(at));
          continue;
        }
        if (db.appCalls(localDay(at), app) >= appCap) {
          skipped.push(`app daily cap ${appCap}`);
          break;
        }

        const result = await provider.run({
          system: fullSystem, prompt, images, schema: envelopeSchema, tier,
        });
        let invalid = result.ok ? validate(result.output) : null;
        db.insertCall({
          ts: at.toISOString(), day: localDay(at), provider: provider.name, app, decisionId: id,
          ok: result.ok && !invalid, kind: invalid ? "bad_output" : result.kind,
          error: invalid ?? result.error, model: result.model,
          tokensIn: result.tokensIn, tokensOut: result.tokensOut, latencyMs: now() - at,
        });

        if (result.ok && !invalid) {
          const { decision, reason, confidence } = result.output;
          record({
            outputJson: JSON.stringify(decision), reason, confidence,
            provider: provider.name, model: result.model, status: "ok",
          });
          return {
            status: 200,
            body: {
              id, decision, reason, confidence, provider: provider.name,
              model: result.model, cached: false, latency_ms: now() - started,
            },
          };
        }

        if (invalid || result.kind === "bad_output") {
          sawInvalid = true;
          skipped.push(`${provider.name}: invalid output (${invalid ?? result.error})`);
        } else {
          trip(provider.name, result);
          skipped.push(`${provider.name}: ${result.kind} (${result.error})`);
          retryAt = Math.min(retryAt, new Date(breakers.get(provider.name)?.until ?? 0).getTime());
        }
      }
    } finally {
      release();
    }

    const error = skipped.join("; ");
    if (sawInvalid && retryAt === Infinity) {
      record({ status: "invalid", error });
      return { status: 422, body: { error: "no_valid_output", detail: error } };
    }
    record({ status: "unavailable", error });
    const retryAfter = retryAt === Infinity ? 300 : Math.max(1, Math.ceil((retryAt - now()) / 1000));
    return { status: 503, body: { error: "unavailable", detail: error, retry_after: retryAfter } };
  }

  return { decide, status };
}
