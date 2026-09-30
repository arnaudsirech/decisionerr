import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { arrClient, decisionerrClient, runPicker } from "./agent.mjs";

const env = process.env;
const need = (name) => {
  if (!env[name]) throw new Error(`${name} is required`);
  return env[name];
};

const config = {
  dryRun: env.DRY_RUN !== "0",
  maxTargets: Number(env.MAX_TARGETS ?? 4),
  maxGrabs: Number(env.MAX_GRABS ?? 2),
  minConfidence: Number(env.MIN_CONFIDENCE ?? 0.75),
  cooldownHours: Number(env.COOLDOWN_HOURS ?? 72),
  minAiredHours: Number(env.MIN_AIRED_HOURS ?? 48),
};

const stateFile = env.STATE_FILE ?? join(env.HOME ?? "/tmp", "decisionerr", "data", "arr-agent-state.json");
let state = { asked: {} };
try {
  state = JSON.parse(readFileSync(stateFile, "utf8"));
} catch {
  // first run
}

const here = dirname(fileURLToPath(import.meta.url));
const preferencesFile = env.PREFERENCES_FILE ?? join(here, "..", "preferences.md");
let system;
try {
  system = readFileSync(preferencesFile, "utf8");
} catch {
  throw new Error(`${preferencesFile} missing: copy arr-agent/preferences.example.md and edit it`);
}

const sonarr = env.SONARR_URL ? arrClient({ url: env.SONARR_URL, apiKey: need("SONARR_API_KEY") }) : null;
const radarr = env.RADARR_URL ? arrClient({ url: env.RADARR_URL, apiKey: need("RADARR_API_KEY") }) : null;
const decide = decisionerrClient({ url: env.DECISIONERR_URL ?? "http://127.0.0.1:8790", token: need("DECISIONERR_TOKEN") });

const log = (line) => console.log(JSON.stringify(line));

try {
  await runPicker({ sonarr, radarr, decide, state, system, config, log });
} finally {
  mkdirSync(dirname(stateFile), { recursive: true });
  writeFileSync(`${stateFile}.tmp`, JSON.stringify(state, null, 2));
  renameSync(`${stateFile}.tmp`, stateFile);
}
