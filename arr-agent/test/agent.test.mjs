import assert from "node:assert/strict";
import { test } from "node:test";
import { runPicker } from "../src/agent.mjs";
import { compactReleases, resolvePick } from "../src/candidates.mjs";
import { dueTargets, sonarrTargets } from "../src/targets.mjs";

const NOW = new Date("2026-09-30T12:00:00Z");
const series = { title: "Example Show", year: 2010, seriesType: "standard", originalLanguage: { name: "English" } };
const ep = (id, season, number, extra = {}) => ({
  id, seriesId: 42, seasonNumber: season, episodeNumber: number, monitored: true, hasFile: false,
  airDateUtc: "2010-01-01T00:00:00Z", series, ...extra,
});
const release = (title, extra = {}) => ({
  guid: `g-${title}`, indexerId: 7, title, indexer: "TrackerA", size: 12 * 2 ** 30, seeders: 50, leechers: 1,
  protocol: "torrent", ageHours: 48, quality: { quality: { name: "WEBDL-1080p" } }, languages: [{ name: "French" }],
  fullSeason: true, seasonNumber: 1, approved: true, rejections: [], ...extra,
});

test("episodes group into season and episode targets, recent airings wait", () => {
  const targets = sonarrTargets(
    [ep(1, 1, 1), ep(2, 1, 2), ep(3, 2, 5), ep(4, 3, 1, { airDateUtc: "2026-09-29T20:00:00Z" }), ep(5, 4, 1, { hasFile: true })],
    { now: NOW, minAiredHours: 48 },
  );
  assert.deepEqual(targets.map((t) => t.key), ["sonarr:season:42:1", "sonarr:episode:3"]);
  assert.deepEqual(targets[0].missingEpisodes, [1, 2]);
});

test("due targets: never asked first, cooldown respected, limit applied", () => {
  const targets = [{ key: "a" }, { key: "b" }, { key: "c" }];
  const asked = { a: "2026-09-30T00:00:00Z", b: "2026-09-20T00:00:00Z" };
  assert.deepEqual(dueTargets(targets, asked, { now: NOW, cooldownHours: 72, limit: 5 }).map((t) => t.key), ["c", "b"]);
  assert.equal(dueTargets(targets, asked, { now: NOW, cooldownHours: 72, limit: 1 }).length, 1);
});

test("blocklisted, dead and usenet releases never reach the model", () => {
  const out = compactReleases([
    release("ok", { seeders: 5 }),
    release("best", { seeders: 90 }),
    release("dead", { seeders: 0 }),
    release("blocked", { rejections: ["Release is blocklisted"] }),
    release("nzb", { protocol: "usenet" }),
    release("objrej", { rejections: [{ reason: "x", message: "Release is blocklisted" }] }),
  ]);
  assert.deepEqual(out.map((c) => c.view.title), ["best", "ok"]);
  assert.equal(out[0].view.n, 0);
  assert.equal(out[0].view.size_gb, 12);
});

test("a season target only accepts a pack of that season", () => {
  const target = { kind: "season", season: 1 };
  const candidates = compactReleases([release("s1"), release("s2", { seasonNumber: 2 }), release("ep", { fullSeason: false })]);
  const byTitle = (t) => candidates.find((c) => c.view.title === t).view.n;
  assert.equal(resolvePick(target, candidates, byTitle("s1")).title, "s1");
  assert.match(resolvePick(target, candidates, byTitle("s2")), /not a season 1 pack/);
  assert.match(resolvePick(target, candidates, byTitle("ep")), /not a season 1 pack/);
  assert.match(resolvePick(target, candidates, 99), /not a candidate/);
  assert.match(resolvePick(target, candidates, null), /no acceptable/);
});

function fakeSonarr(releases) {
  const posts = [];
  return {
    posts,
    async get(path) {
      if (path.startsWith("/api/v3/wanted/missing")) return { records: [ep(1, 1, 1), ep(2, 1, 2), ep(3, 2, 1), ep(4, 2, 2)] };
      if (path.startsWith("/api/v3/blocklist")) return { records: [{ seriesId: 42, sourceTitle: "Example.Show S01 2160p HDR" }, { seriesId: 9, sourceTitle: "other" }] };
      if (path.startsWith("/api/v3/release")) {
        const season = Number(/seasonNumber=(\d+)/.exec(path)?.[1] ?? 1);
        return releases.map((r) => ({ ...r, seasonNumber: season }));
      }
      throw new Error(path);
    },
    async post(path, body) {
      posts.push({ path, body });
    },
  };
}

const config = { dryRun: true, maxTargets: 4, maxGrabs: 2, minConfidence: 0.75, cooldownHours: 72, minAiredHours: 48 };

async function run({ answers, dryRun = true, releases = [release("Example.Show.S01.MULTI.1080p")] }) {
  const sonarr = fakeSonarr(releases);
  const lines = [];
  const payloads = [];
  const queue = [...answers];
  const state = { asked: {} };
  await runPicker({
    sonarr, radarr: null, state, system: "rules", now: NOW,
    config: { ...config, dryRun },
    decide: async (payload) => {
      payloads.push(payload);
      return queue.shift();
    },
    log: (line) => lines.push(line),
  });
  return { sonarr, lines, payloads, state };
}

const ok = (pick, confidence = 0.9) => ({ status: 200, body: { id: "dec_1", decision: { pick }, reason: "MULTI has VO", confidence } });

test("dry run logs would_grab and never posts", async () => {
  const { sonarr, lines, payloads } = await run({ answers: [ok(0), ok(null)] });
  assert.equal(sonarr.posts.length, 0);
  assert.equal(lines.find((l) => l.event === "would_grab").release, "Example.Show.S01.MULTI.1080p");
  assert.equal(lines.find((l) => l.event === "no_grab").why, "no acceptable release");
  assert.deepEqual(payloads[0].input.already_rejected_by_user, ["Example.Show S01 2160p HDR"]);
  assert.equal(payloads[0].input.target.kind, "season");
});

test("live run grabs through Sonarr, low confidence does not", async () => {
  const { sonarr, lines } = await run({ answers: [ok(0), ok(0, 0.5)], dryRun: false });
  assert.deepEqual(sonarr.posts, [{ path: "/api/v3/release", body: { guid: "g-Example.Show.S01.MULTI.1080p", indexerId: 7 } }]);
  assert.match(lines.find((l) => l.event === "no_grab").why, /confidence/);
});

test("decisionerr 503 stops the run and leaves the target due", async () => {
  const { lines, state } = await run({ answers: [{ status: 503, body: { error: "unavailable", retry_after: 60 } }, ok(0)] });
  assert.equal(lines.at(-1).event, "stop");
  assert.equal(Object.keys(state.asked).length, 0);
});

test("no usable releases skips the model call but still cools down", async () => {
  const { payloads, state } = await run({ answers: [], releases: [release("dead", { seeders: 0 })] });
  assert.equal(payloads.length, 0);
  assert.equal(Object.keys(state.asked).length, 2);
});
