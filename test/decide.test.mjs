import assert from "node:assert/strict";
import { test } from "node:test";
import { openDb } from "../src/db.mjs";
import { createDecider } from "../src/decide.mjs";
import { parseAgy } from "../src/providers/agy.mjs";
import { parseClaude } from "../src/providers/claude.mjs";

const SCHEMA = {
  type: "object",
  properties: { pick: { type: ["string", "null"] } },
  required: ["pick"],
  additionalProperties: false,
};
const GOOD = { decision: { pick: "A" }, reason: "A is a real video", confidence: 0.9 };

function fake(name, results, { supportsImages = true } = {}) {
  const queue = [...results];
  const provider = {
    name,
    supportsImages,
    calls: 0,
    async run() {
      provider.calls += 1;
      const next = queue.length > 1 ? queue.shift() : queue[0];
      return { model: `${name}-model`, ...next };
    },
  };
  return provider;
}

const quiet = { warn() {}, error() {} };

function setup({ claude, agy, claudeCap = 100, agyCap = 50, appCap = 1000, clock } = {}) {
  const db = openDb(":memory:");
  let t = clock ?? new Date("2026-09-30T10:00:00");
  const decider = createDecider({
    db,
    apps: { arr: { dailyCap: appCap } },
    providers: [
      { provider: claude ?? fake("claude", [{ ok: true, output: GOOD }]), dailyCap: claudeCap },
      { provider: agy ?? fake("agy", [{ ok: true, output: GOOD }], { supportsImages: false }), dailyCap: agyCap },
    ],
    now: () => t,
    log: quiet,
  });
  return { db, decider, advance: (ms) => (t = new Date(t.getTime() + ms)) };
}

const request = (overrides = {}) => ({
  task: "pick_release",
  system: "Pick a release.",
  input: { releases: ["A", "B"] },
  schema: SCHEMA,
  tier: "fast",
  images: [],
  cacheTtlS: 0,
  ...overrides,
});

test("returns the envelope from the first provider", async () => {
  const { decider, db } = setup();
  const out = await decider.decide("arr", request());
  assert.equal(out.status, 200);
  assert.deepEqual(out.body.decision, { pick: "A" });
  assert.equal(out.body.provider, "claude");
  assert.equal(out.body.confidence, 0.9);
  assert.equal(db.providerCalls("2026-09-30", "claude"), 1);
  assert.equal(db.listDecisions({ app: "arr", since: "2000", limit: 10 })[0].status, "ok");
});

test("falls back to agy on a limit and skips claude while it is down", async () => {
  const claude = fake("claude", [{ ok: false, kind: "limit", error: "usage limit" }]);
  const agy = fake("agy", [{ ok: true, output: GOOD }], { supportsImages: false });
  const { decider, advance } = setup({ claude, agy });
  assert.equal((await decider.decide("arr", request())).body.provider, "agy");
  assert.equal((await decider.decide("arr", request())).body.provider, "agy");
  assert.equal(claude.calls, 1);
  advance(31 * 60_000);
  await decider.decide("arr", request());
  assert.equal(claude.calls, 2);
});

test("claude cap sends the rest to agy, agy cap then answers 503", async () => {
  const { decider } = setup({ claudeCap: 2, agyCap: 1 });
  const providers = [];
  for (let i = 0; i < 4; i += 1) {
    const out = await decider.decide("arr", request());
    providers.push(out.status === 200 ? out.body.provider : out.status);
  }
  assert.deepEqual(providers, ["claude", "claude", "agy", 503]);
});

test("caps reset at local midnight", async () => {
  const { decider, advance } = setup({ claudeCap: 1, agyCap: 0, clock: new Date("2026-09-30T23:59:00") });
  assert.equal((await decider.decide("arr", request())).status, 200);
  const capped = await decider.decide("arr", request());
  assert.equal(capped.status, 503);
  assert.equal(capped.body.retry_after, 60);
  advance(2 * 60_000);
  assert.equal((await decider.decide("arr", request())).status, 200);
});

test("app cap answers 429 before any provider runs", async () => {
  const claude = fake("claude", [{ ok: true, output: GOOD }]);
  const { decider } = setup({ claude, appCap: 1 });
  assert.equal((await decider.decide("arr", request())).status, 200);
  const out = await decider.decide("arr", request());
  assert.equal(out.status, 429);
  assert.equal(out.body.error, "app_cap");
  assert.equal(claude.calls, 1);
});

test("output that breaks the schema falls through, and 422 when nobody complies", async () => {
  const bad = { ok: true, output: { decision: { pick: 3 }, reason: "x", confidence: 0.5 } };
  const { decider } = setup({
    claude: fake("claude", [bad]),
    agy: fake("agy", [bad], { supportsImages: false }),
  });
  const out = await decider.decide("arr", request());
  assert.equal(out.status, 422);
  assert.match(out.body.detail, /claude: invalid output/);
  assert.match(out.body.detail, /agy: invalid output/);
});

test("an invalid first answer is rescued by the second provider", async () => {
  const bad = { ok: true, output: { decision: { pick: "A" }, reason: "x" } };
  const { decider } = setup({ claude: fake("claude", [bad]) });
  const out = await decider.decide("arr", request());
  assert.equal(out.status, 200);
  assert.equal(out.body.provider, "agy");
});

test("cache hit returns the stored answer without a call", async () => {
  const claude = fake("claude", [{ ok: true, output: GOOD }]);
  const { decider, db, advance } = setup({ claude });
  await decider.decide("arr", request({ cacheTtlS: 3600 }));
  const hit = await decider.decide("arr", request({ cacheTtlS: 3600 }));
  assert.equal(hit.body.cached, true);
  assert.deepEqual(hit.body.decision, { pick: "A" });
  assert.equal(claude.calls, 1);
  advance(3601_000);
  assert.equal((await decider.decide("arr", request({ cacheTtlS: 3600 }))).body.cached, false);
  assert.equal(db.appCalls("2026-09-30", "arr"), 2);
});

test("image requests skip providers that cannot see images", async () => {
  const claude = fake("claude", [{ ok: false, kind: "transient", error: "timeout" }]);
  const agy = fake("agy", [{ ok: true, output: GOOD }], { supportsImages: false });
  const { decider } = setup({ claude, agy });
  const out = await decider.decide("arr", request({ images: [{ media_type: "image/png", data: "AAAA" }] }));
  assert.equal(out.status, 503);
  assert.equal(agy.calls, 0);
  assert.match(out.body.detail, /agy: no images/);
});

test("an uncompilable schema is a 400", async () => {
  const { decider } = setup();
  const out = await decider.decide("arr", request({ schema: { type: "nope" } }));
  assert.equal(out.status, 400);
  assert.equal(out.body.error, "bad_schema");
});

test("parseClaude reads structured_output and classifies limits", () => {
  const ok = parseClaude({ stdout: `${JSON.stringify({ type: "result", structured_output: GOOD, usage: { input_tokens: 5, output_tokens: 2 } })}\n` }, "m");
  assert.equal(ok.ok, true);
  assert.equal(ok.tokensIn, 5);
  const limit = parseClaude({ stdout: JSON.stringify({ type: "result", is_error: true, api_error_status: 429, result: "Claude AI usage limit reached|1790000000" }) }, "m");
  assert.equal(limit.kind, "limit");
  assert.equal(limit.retryAt, 1790000000_000);
  assert.equal(parseClaude({ stdout: JSON.stringify({ type: "result", is_error: true, api_error_status: 401, result: "x" }) }, "m").kind, "auth");
  assert.equal(parseClaude({ stdout: "", stderr: "", timedOut: true }, "m").kind, "transient");
});

test("parseAgy reads the result event and rejects tool use", () => {
  const line = (result) => `warning: x\n${JSON.stringify({ event: "result", result })}\n`;
  assert.equal(parseAgy({ stdout: line({ status: "SUCCESS", structured_output: GOOD }) }, "m").ok, true);
  const tools = parseAgy({ stdout: line({ status: "SUCCESS", structured_output: GOOD, denied_actions: [{ action: "command" }] }) }, "m");
  assert.equal(tools.ok, false);
  assert.equal(tools.kind, "bad_output");
  assert.equal(parseAgy({ stdout: line({ status: "ERROR", error: "quota exceeded" }) }, "m").kind, "limit");
});
