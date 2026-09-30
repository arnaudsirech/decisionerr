# Decisionerr

Shared LLM decision service for self-hosted apps: input + JSON Schema in, schema-valid
decision out, with a `reason` and a `confidence` on every answer.

- Providers, in order: `claude -p` (subscription, Haiku by default, **100 calls/day**),
  then `agy -p` (Antigravity headless, **50 calls/day**). No metered API.
- Every call is logged in SQLite, and the daily caps are counted from that log.
- Apps own their prompts and schemas, and the token decides which app is calling.

See [DESIGN.md](DESIGN.md) for the design.

## API

```
POST /v1/decide          Authorization: Bearer <app token>
{ "task": "pick_release", "system": "...", "input": {...} | "text",
  "schema": {...}, "tier": "fast" | "thorough" | "best", "images": [], "cache_ttl_s": 0 }

200 { id, decision, reason, confidence, provider, model, cached, latency_ms }
400 bad request / bad schema    422 no provider gave schema-valid output
429 app daily cap               503 providers down or capped (retry_after, seconds)

GET /v1/decisions?task=&since=&limit=     that app's decisions
GET /healthz                              providers, calls used today, breakers
```

## Deploy (server)

```sh
git clone https://github.com/arnaudsirech/decisionerr.git ~/decisionerr
cd ~/decisionerr && npm ci --omit=dev
cp apps.example.json apps.json && chmod 600 apps.json   # set tokens
cp deploy/decisionerr.service ~/.config/systemd/user/
systemctl --user daemon-reload && systemctl --user enable --now decisionerr
```

`claude` and `agy` must be logged in for the service user. Node >= 24 (`node:sqlite`).

## Test

```sh
npm test
```

## arr-agent (first client)

`arr-agent/` is the fallback picker for Sonarr/Radarr. On a timer (every 4 h), it takes
monitored items that are still missing:
- 2+ missing episodes in a season → one season search; a lone episode → an episode search.
- Missing, available movies → a movie search.

It sends the releases (blocklisted and dead ones removed in code) to Decisionerr, along
with your rules in `arr-agent/preferences.md` (start from
[`preferences.example.md`](arr-agent/preferences.example.md)), and grabs the
pick through Sonarr/Radarr. Each target is asked at most every 72 h; a search that found nothing is retried after 8 h. `DRY_RUN=1` (the
default) only logs `would_grab` lines: `journalctl --user -u arr-agent`.

```sh
cp arr-agent/arr-agent.env.example arr-agent.env && chmod 600 arr-agent.env   # fill in
cp arr-agent/preferences.example.md arr-agent/preferences.md                  # edit
cp deploy/arr-agent.{service,timer} ~/.config/systemd/user/
systemctl --user daemon-reload && systemctl --user enable --now arr-agent.timer
```

It never deletes files. Its only write is `POST /api/v3/release` (grab), capped per run.
