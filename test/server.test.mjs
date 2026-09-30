import assert from "node:assert/strict";
import { test } from "node:test";
import { openDb } from "../src/db.mjs";
import { createDecider } from "../src/decide.mjs";
import { createApp, parseRequest } from "../src/server.mjs";

const TOKEN = "a".repeat(64);
const OUTPUT = { decision: { ok: true }, reason: "fine", confidence: 1 };

async function withServer(fn) {
  const db = openDb(":memory:");
  const apps = { arr: { token: TOKEN, dailyCap: 10 } };
  const decider = createDecider({
    db,
    apps,
    providers: [{ provider: { name: "claude", supportsImages: true, run: async () => ({ ok: true, output: OUTPUT, model: "m" }) }, dailyCap: 10 }],
  });
  const server = createApp({ decider, db, apps }).listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await fn(base);
  } finally {
    server.close();
  }
}

const body = {
  task: "t",
  system: "Say ok.",
  input: "x",
  schema: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] },
};

test("decide needs a known token", async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/v1/decide`, { method: "POST", body: JSON.stringify(body), headers: { authorization: "Bearer nope" } });
    assert.equal(res.status, 401);
  });
});

test("decide answers and the decision is listed for that app", async () => {
  await withServer(async (base) => {
    const headers = { authorization: `Bearer ${TOKEN}` };
    const res = await fetch(`${base}/v1/decide`, { method: "POST", body: JSON.stringify(body), headers });
    assert.equal(res.status, 200);
    assert.deepEqual((await res.json()).decision, { ok: true });
    const list = await (await fetch(`${base}/v1/decisions?task=t`, { headers })).json();
    assert.equal(list.decisions.length, 1);
    const health = await (await fetch(`${base}/healthz`)).json();
    assert.equal(health.providers[0].usedToday, 1);
  });
});

test("parseRequest rejects malformed requests", () => {
  assert.match(parseRequest({ ...body, system: "" }), /system/);
  assert.match(parseRequest({ ...body, tier: "max" }), /tier/);
  assert.match(parseRequest({ ...body, images: [{ media_type: "text/plain", data: "" }] }), /images/);
  assert.equal(typeof parseRequest(body), "object");
});
