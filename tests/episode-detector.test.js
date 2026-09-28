const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const root = path.resolve(__dirname, "..");
function api() {
  const context = vm.createContext({ URL });
  for (const file of [
    "src/shared/constants.js", "src/shared/string-transforms.js",
    "src/shared/episode-detector.js", "src/shared/url-fixers.js",
    "src/shared/time.js", "src/shared/advanced.js"
  ]) vm.runInContext(fs.readFileSync(path.join(root, file), "utf8"), context);
  return context.OpenDSkipper;
}

test("title key uses URL Fixers while top-url detector reads raw URL", () => {
  const { UrlFixers, EpisodeDetector } = api();
  const raw = "https://site.test/anime/2-12/";
  const rule = { id: "cut", enabled: true, operation: "truncateAfter", value: "/anime" };
  const titleId = UrlFixers.applyUrlFixers(raw, [rule]).profileKey;
  const detected = EpisodeDetector.detectEpisode({ type: "top-url", transforms: [
    { type: "lastNonEmptyPart", value: "/" }
  ] }, { topUrl: raw, profileKey: titleId });
  assert.equal(titleId, "https://site.test");
  assert.equal(detected.id, "2-12");
  assert.equal(EpisodeDetector.detectEpisode({ type: "top-url", transforms: [] }, {
    topUrl: "2-12", profileKey: "other"
  }).id, "2-12");
});

test("URL Fixers retain literal ordered truncate, remove and replace behavior", () => {
  const { UrlFixers } = api();
  const raw = "https://site.test/a/X/b/X";
  const rule = (id, operation, value, extra = {}) => ({
    id, enabled: true, operation, value, ...extra
  });
  assert.equal(UrlFixers.applyUrlFixers(raw, [rule("first", "truncateAfter", "/X")]).profileKey,
    "https://site.test/a");
  assert.equal(UrlFixers.applyUrlFixers(raw, [rule("last", "truncateAfterLast", "/X")]).profileKey,
    "https://site.test/a/X/b");
  assert.equal(UrlFixers.applyUrlFixers(raw, [rule("remove", "removeExact", "/X",
    { position: "anywhere" })]).profileKey, "https://site.test/a/b");
  assert.equal(UrlFixers.applyUrlFixers(raw, [rule("replace", "replaceExact", "/X",
    { position: "end", replacement: "/Y" })]).profileKey, "https://site.test/a/X/b/Y");
  assert.equal(UrlFixers.applyUrlFixers(raw, [rule("invalid", "truncateAfter", "site")]).profileKey,
    raw); // Invalid transformed URL falls back to the original key.
});

test("literal transforms handle trailing separator, query parameter, trim and empty result", () => {
  const { EpisodeDetector, StringTransforms } = api();
  assert.equal(StringTransforms.apply("https://site/anime/2-12/", {
    type: "lastNonEmptyPart", value: "/"
  }), "2-12");
  assert.equal(StringTransforms.apply("https://site/watch?episode=abc123", {
    type: "queryParameter", value: "episode"
  }), "abc123");
  assert.equal(StringTransforms.apply("season/2/episode/12", {
    type: "takeAfterLast", value: "/"
  }), "12");
  assert.equal(EpisodeDetector.normalizeId("  S2   E4 \n"), "S2 E4");
  assert.equal(EpisodeDetector.normalizeId("  \n  "), null);
  assert.equal(EpisodeDetector.detectEpisode({ type: "top-url", transforms: [
    { type: "queryParameter", value: "missing" }
  ] }, { topUrl: "https://site/watch?episode=abc123" }), null);
});

test("both detector types use the same transform pipeline", () => {
  const { EpisodeDetector } = api();
  const transforms = [
    { type: "truncateAfter", value: "?" },
    { type: "lastNonEmptyPart", value: "/" },
    { type: "replaceExact", value: "ep-", replacement: "", position: "start" }
  ];
  const value = "https://site/watch/ep-abc123?token=x";
  const top = EpisodeDetector.detectEpisode({ type: "top-url", transforms }, { topUrl: value });
  const player = EpisodeDetector.detectEpisode({ type: "player-url", source: "frame-url", transforms }, {
    candidates: [{ source: "frame-url", value }]
  });
  assert.equal(top.id, "abc123");
  assert.equal(player.id, top.id);
});

test("player source type is stored independently of URL and unavailable source never falls back", () => {
  const { EpisodeDetector } = api();
  const config = EpisodeDetector.normalizeConfig({ type: "player-url", source: "video-current-src",
    transforms: [{ type: "lastNonEmptyPart", value: "/" }] });
  assert.equal(config.source, "video-current-src");
  assert.equal(Object.hasOwn(config, "url"), false);
  assert.equal(EpisodeDetector.detectEpisode(config, { candidates: [
    { source: "video-current-src", value: "https://player/episode-1" }
  ] }).id, "episode-1");
  assert.equal(EpisodeDetector.detectEpisode(config, { candidates: [
    { source: "video-current-src", value: "https://player/episode-2" }
  ] }).id, "episode-2");
  assert.equal(EpisodeDetector.detectEpisode(config, { candidates: [
    { source: "video-src", value: "https://other/episode-3" }
  ] }), null);
});

test("candidate collector includes only present frame, iframe, video and source values", () => {
  const { EpisodeDetector } = api();
  const candidates = EpisodeDetector.collectCandidates({
    frameUrl: "https://frame/ep1",
    iframes: [{ src: "https://iframe/ep1" }, { src: "" }],
    videos: [{ currentSrc: "https://cdn/current", src: "", sources: [
      { src: "https://cdn/source" }, { src: "" }
    ] }]
  });
  assert.deepEqual(Array.from(candidates, ({ source }) => source), [
    "frame-url", "iframe-src", "video-current-src", "source-src"
  ]);
  assert.deepEqual(Array.from(EpisodeDetector.collectCandidates({
    frameUrl: "https://empty", iframes: [], videos: []
  })), []);
});

test("same ID preserves handled state; new ID resolves new ranges; null retains last valid ID", () => {
  const { EpisodeDetector, Advanced } = api();
  const timings = { "0:1000": { start: 0, end: 10 }, "0:2000": { start: 0, end: 20 } };
  const profile = { episodes: { first: { ranges: ["0:1000"] }, second: { ranges: ["0:2000"] } } };
  const first = EpisodeDetector.transition(null, { id: "first" });
  assert.equal(first.changed, true);
  assert.equal(Advanced.resolveEpisode(profile, timings, first.id)[0].end, 10);
  const same = EpisodeDetector.transition(first.id, { id: "first" });
  assert.equal(same.changed, false);
  const temporary = EpisodeDetector.transition(same.id, null);
  assert.equal(temporary.id, "first");
  assert.equal(temporary.changed, false);
  const second = EpisodeDetector.transition(temporary.id, { id: "second" });
  assert.equal(second.changed, true);
  assert.equal(Advanced.resolveEpisode(profile, timings, second.id)[0].end, 20);
  const reset = EpisodeDetector.transition(second.id, null, true);
  assert.equal(reset.id, null);
  assert.equal(reset.changed, true);
});
