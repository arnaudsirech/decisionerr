import { compactReleases, PICK_SCHEMA, resolvePick } from "./candidates.mjs";
import { dueTargets, radarrTargets, searchPath, sonarrTargets } from "./targets.mjs";

/** Minimal *arr client. `fetchImpl` is injectable for tests. */
export function arrClient({ url, apiKey, fetchImpl = fetch, timeoutMs = 180_000 }) {
  async function call(method, path, body) {
    const res = await fetchImpl(`${url}${path}`, {
      method,
      headers: { "X-Api-Key": apiKey, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${(await res.text()).slice(0, 200)}`);
    const text = await res.text();
    return text ? JSON.parse(text) : null;
  }
  return { get: (path) => call("GET", path), post: (path, body) => call("POST", path, body) };
}

export function decisionerrClient({ url, token, fetchImpl = fetch }) {
  return async (payload) => {
    const res = await fetchImpl(`${url}/v1/decide`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(300_000),
    });
    return { status: res.status, body: await res.json() };
  };
}

function rejectedByUser(blocklist, target) {
  return blocklist
    .filter((b) => (target.app === "sonarr" ? b.seriesId === target.seriesId : b.movieId === target.movieId))
    .slice(0, 15)
    .map((b) => b.sourceTitle);
}

/**
 * One pass of the fallback picker. Returns the log lines it produced; `state`
 * is mutated (targets asked this run) and must be saved by the caller.
 */
export async function runPicker({ sonarr, radarr, decide, state, system, config, now = new Date(), log }) {
  const targets = [];
  const blocklists = {};
  if (sonarr) {
    const missing = await sonarr.get("/api/v3/wanted/missing?pageSize=2000&monitored=true&includeSeries=true");
    targets.push(...sonarrTargets(missing.records, { now, minAiredHours: config.minAiredHours }));
    blocklists.sonarr = (await sonarr.get("/api/v3/blocklist?pageSize=500")).records;
  }
  if (radarr) {
    targets.push(...radarrTargets(await radarr.get("/api/v3/movie")));
    blocklists.radarr = (await radarr.get("/api/v3/blocklist?pageSize=500")).records;
  }

  const due = dueTargets(targets, state.asked, {
    now, cooldownHours: config.cooldownHours, limit: config.maxTargets,
  });
  log({ event: "run", targets: targets.length, due: due.length, dryRun: config.dryRun });

  let grabs = 0;
  for (const target of due) {
    const arr = target.app === "sonarr" ? sonarr : radarr;
    const label = `${target.title}${target.kind === "movie" ? ` (${target.year})` : ` S${String(target.season).padStart(2, "0")}${target.kind === "episode" ? `E${target.missingEpisodes[0]}` : ""}`}`;

    let candidates;
    try {
      candidates = compactReleases(await arr.get(searchPath(target)));
    } catch (error) {
      log({ event: "error", target: label, why: `search failed: ${error.message}` });
      continue;
    }
    state.asked[target.key] = now.toISOString();
    if (candidates.length === 0) {
      log({ event: "skip", target: label, why: "no usable releases" });
      continue;
    }

    const { key, app, ...context } = target;
    const res = await decide({
      task: `pick_${target.kind}`,
      system,
      input: {
        target: context,
        already_rejected_by_user: rejectedByUser(blocklists[target.app], target),
        candidates: candidates.map((c) => c.view),
      },
      schema: PICK_SCHEMA,
    });

    if (res.status === 429 || res.status === 503) {
      delete state.asked[target.key];
      log({ event: "stop", target: label, why: `decisionerr ${res.status} ${res.body.error}`, retry_after: res.body.retry_after });
      break;
    }
    if (res.status !== 200) {
      log({ event: "error", target: label, why: `decisionerr ${res.status} ${res.body.error} ${res.body.detail ?? ""}` });
      continue;
    }

    const { decision, reason, confidence, id } = res.body;
    const chosen = resolvePick(target, candidates, decision.pick);
    const base = { target: label, decision: id, reason, confidence };
    if (typeof chosen === "string") {
      log({ event: "no_grab", ...base, why: chosen });
      continue;
    }
    if (confidence < config.minConfidence) {
      log({ event: "no_grab", ...base, release: chosen.title, why: `confidence below ${config.minConfidence}` });
      continue;
    }
    if (grabs >= config.maxGrabs) {
      log({ event: "no_grab", ...base, release: chosen.title, why: `grab cap ${config.maxGrabs} reached` });
      continue;
    }
    if (config.dryRun) {
      log({ event: "would_grab", ...base, release: chosen.title, seeders: chosen.seeders });
      grabs += 1;
      continue;
    }
    try {
      await arr.post("/api/v3/release", { guid: chosen.guid, indexerId: chosen.indexerId });
    } catch (error) {
      log({ event: "error", ...base, release: chosen.title, why: `grab failed: ${error.message}` });
      continue;
    }
    grabs += 1;
    log({ event: "grabbed", ...base, release: chosen.title, seeders: chosen.seeders });
  }
}
