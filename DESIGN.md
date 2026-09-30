# Design — Decisionerr + arr-agent

Decisionerr is one small service that turns "here is some input + a JSON Schema" into a
schema-valid decision. It handles provider fallback, daily caps, logging and caching, so
the apps using it only keep their own domain logic.

**No metered API.** Claude runs through a Claude subscription (`claude -p`), and
Antigravity through its headless CLI (`agy -p`). No API keys, no per-token billing.

## Why a separate service

Apps that need "prompt + input → structured JSON, with a fallback when the main provider
fails" tend to each rebuild the same plumbing: provider switch, retries, backoff, JSON
extraction. Decisionerr does it once.

## Scope

**In:** single-turn structured decisions (classify, pick, judge, extract). Text, plus
optional images (Claude only).

**Out:** streaming chat, long agent sessions, and anything that needs tools.
Decisionerr never gives a model tools.

## Architecture

```
app A ─┐
app B ─┼─ POST /v1/decide ─▶ decisionerr (systemd user service, Node)
app C ─┘   bearer token          │
                                 ├─ 1. claude -p  (subscription, daily cap, default 100)
                                 ├─ 2. agy -p     (fallback, daily cap, default 50)
                                 ├─ validate against schema; invalid → next provider
                                 └─ SQLite: every call logged
```

- **Runs as a systemd user service**, not in a container: both CLIs and their logins
  live in the service user's home.
- **Node ≥ 24** (`node:sqlite`). The only dependency is `ajv`, to check answers against the schema.
- **Listens on loopback by default.** Each app has its own bearer token, and the token
  decides which app is calling. Bind to a LAN address only behind a firewall.

## API

See [README.md](README.md). Two conventions:

- **Every schema is wrapped** as `{ decision, reason, confidence }`. Apps get thresholds
  for free ("act only if confidence ≥ 0.8"), and the logs are readable.
- **Apps own their prompt and schema.** Decisionerr logs a hash of the prompt, so prompt
  versions are traceable without a central registry.

## Providers

1. **Claude:** `claude -p --input-format stream-json --output-format stream-json
   --model <haiku|sonnet> --tools "" --strict-mcp-config --setting-sources ""
   --no-session-persistence --system-prompt … --json-schema …`. With no tools and no
   settings, text inside an input can only shape the JSON that comes back.
2. **Antigravity:** `agy -p= --input-format stream-json --output-format stream-json
   --json-schema <file> --sandbox --print-timeout …`, never with
   `--dangerously-skip-permissions`.
   - The prompt goes over stdin as `{"event":"user","message":{"content":"…"}}`, because
     a single argument is capped at 128 KiB.
   - Headless mode auto-denies commands, and reads or writes outside the workspace. It
     *can* write inside its workspace, so each call runs in a fresh temp dir that is
     deleted afterwards.
   - A result that reports `denied_actions` is treated as invalid.

**Circuit breaker, not per-call retries.** After a usage limit, a provider is skipped
until the reset time the CLI reports (or 30 min if it gives none). After a login error
it's skipped for 60 min and the error is logged loudly. After a timeout or other
transient error, 5 min.

**Caps.** Daily per provider and per app, counted from the `calls` table and reset at
local midnight. Past them, the answer is 503 or 429 with `retry_after`, never a silent
overrun. Concurrency is capped at 2, since the subscription's limits would only queue more.

## Storage (SQLite)

- `calls`: one row per CLI invocation. The caps are counted from here, with no separate
  counter to drift.
- `decisions`: one row per request (input, output, reason, confidence, provider,
  status). Used for audit, dry-run review, and as an eval set when a prompt changes.

## arr-agent (first client)

A oneshot on a timer. It talks to Sonarr/Radarr and calls Decisionerr, and it holds all
the *arr knowledge.

- **Fallback picker.** It takes monitored items that are still missing (season packs
  when a season has 2+ missing episodes) and runs Sonarr/Radarr's own release search.
  The model gets the releases, the user's rules (`preferences.md`) and the releases the
  user already rejected by hand, and answers with a candidate number or null.
- **The rules that matter are enforced in code, not the prompt:**
  - Blocklisted, dead and usenet releases are removed before the model sees them.
  - A season target only accepts a pack of that season.
  - There's a confidence threshold and a grab cap per run.
  - Each target is cooled down between asks.
- **Its only write is a grab** (`POST /api/v3/release`). It never deletes anything.
- **`DRY_RUN=1` by default:** it logs `would_grab` lines until you trust it.
- **Queue triage is not included.** Existing queue cleaners (e.g. Cleanuparr) already
  handle stalled and slow torrents, and a second automation acting on the same queue
  would fight them.
