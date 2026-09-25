const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const root = path.resolve(__dirname, "..");
function run(relativePath, context) {
  vm.runInContext(fs.readFileSync(path.join(root, relativePath), "utf8"), context, {
    filename: relativePath
  });
}

function timeApi() {
  const context = vm.createContext({});
  run("src/shared/constants.js", context);
  run("src/shared/time.js", context);
  return context.OpenDSkipper.Time;
}

function rangeApi() {
  const context = vm.createContext({});
  run("src/shared/constants.js", context);
  run("src/shared/time.js", context);
  run("src/content/range-executor.js", context);
  return context.OpenDSkipper.RangeExecutor;
}

test("time adapters preserve seconds and parse native time values", () => {
  const time = timeApi();
  assert.equal(time.readCurrentTime({ currentTime: 84.732 }), 84.732);
  assert.equal(time.readDuration({ duration: Infinity }), null);
  assert.equal(time.formatTimeInput(84.732), "00:01:24");
  assert.equal(time.parseTimeInput("00:01:24"), 84);
  assert.equal(time.parseTimeInput("01:24"), 5040);
  assert.equal(time.parseTimeInput("24:00:00"), null);
  assert.equal(time.parseTimeInput("00:60:00"), null);
  assert.ok(Math.abs(time.getFractionalSeconds(84.732) - 0.732) < 1e-9);
  assert.equal(time.clampMediaTime(-1.4, null), 0);
  assert.equal(time.clampMediaTime(20, 10), 10);
  assert.equal(time.clampMediaTime(20, Infinity), 20);
  assert.equal(time.formatTimeInput(91), "00:01:31");
});

test("seek pipeline applies offset, clamps, and protects the natural ending", () => {
  const time = timeApi();
  const video = { currentTime: 0, duration: 100 };
  assert.equal(time.seekTo(video, 10, { timingOffset: { enabled: true, seconds: -1.4 } }), true);
  assert.ok(Math.abs(video.currentTime - 8.6) < 1e-9);
  assert.equal(time.seekTo(video, 10, { timingOffset: { enabled: false, seconds: 50 } }), true);
  assert.equal(video.currentTime, 10);
  assert.equal(time.seekTo(video, 200), true);
  assert.equal(video.currentTime, 99.95);
  assert.equal(time.seekTo(video, 100), false); // No repeated or backward end seek.

  const offsetPastEnd = { currentTime: 40, duration: 100 };
  assert.equal(time.seekTo(offsetPastEnd, 95, {
    timingOffset: { enabled: true, seconds: 10 }
  }), true);
  assert.equal(offsetPastEnd.currentTime, 99.95);

  const unknown = { currentTime: 0, duration: Infinity };
  assert.equal(time.seekTo(unknown, -4), false);
  assert.equal(unknown.currentTime, 0);
  assert.equal(time.seekTo(unknown, 120), true);
  assert.equal(unknown.currentTime, 120);

  const short = { currentTime: 0, duration: 0.02 };
  assert.equal(time.seekTo(short, 10), false);
  assert.equal(short.currentTime, 0);
  assert.equal(time.seekTo(short, NaN), false);
});

test("shared range executor observes boundaries, IDs, precision, and one-shot state", () => {
  const { executeRange } = rangeApi();
  const handled = new Set();
  let writes = 0;
  let position = 84.731;
  const video = {
    duration: 300,
    get currentTime() { return position; },
    set currentTime(value) { position = value; writes++; }
  };
  const first = { id: "some-range", start: 84.732, end: 174.221 };
  assert.equal(executeRange(video, first, handled, {}), false); // Before start.
  position = 84.732;
  assert.equal(executeRange(video, first, handled, {}), true);
  assert.equal(position, 174.221);
  assert.equal(writes, 1);
  assert.equal(handled.has("some-range"), true);
  position = 100;
  assert.equal(executeRange(video, first, handled, {}), false); // Already handled.
  assert.equal(writes, 1);

  const second = { id: "another-range", start: 90, end: 200 };
  assert.equal(executeRange(video, second, handled, {}), true);
  assert.equal(position, 200);
  assert.equal(handled.has("another-range"), true);
  position = 200;
  assert.equal(executeRange(video, { id: "at-end", start: 90, end: 200 }, handled, {}), false);
  position = 201;
  assert.equal(executeRange(video, { id: "past-end", start: 90, end: 200 }, handled, {}), false);
  assert.equal(writes, 2);
});

test("invalid ranges and failed media seek do not become handled", () => {
  const { executeRange } = rangeApi();
  const handled = new Set();
  const video = { currentTime: 0.98, duration: 1 };
  for (const range of [
    { id: "bad-start", start: NaN, end: 1 },
    { id: "negative-start", start: -1, end: 1 },
    { id: "bad-end", start: 0, end: Infinity },
    { id: "same", start: 1, end: 1 },
    { id: "reversed", start: 2, end: 1 },
    { id: "", start: 0, end: 1 }
  ]) {
    assert.equal(executeRange(video, range, handled, {}), false);
  }
  assert.equal(handled.size, 0);
  assert.equal(executeRange(video, { id: "near-end", start: 0, end: 1 }, handled, {}), false);
  assert.equal(handled.has("near-end"), false); // seekTo would move backward past end cap.
  assert.equal(video.currentTime, 0.98);
  video.currentTime = NaN;
  assert.equal(executeRange(video, { id: "invalid-media", start: 0, end: 1 }, handled, {}), false);
  assert.equal(handled.size, 0);

  const rejectedVideo = {
    duration: 10,
    get currentTime() { return 0.5; },
    set currentTime(value) { throw new Error(`Seek rejected: ${value}`); }
  };
  assert.throws(() => executeRange(
    rejectedVideo, { id: "rejected", start: 0, end: 2 }, handled, {}
  ), /Seek rejected/);
  assert.equal(handled.has("rejected"), false);
});

function contentHarness(initialProfile, videoOrVideos) {
  const videos = Array.isArray(videoOrVideos) ? videoOrVideos : [videoOrVideos];
  const listenerMaps = new Map();
  for (const video of videos) {
    const listeners = new Map();
    listenerMaps.set(video, listeners);
    video.addEventListener = (name, callback) => listeners.set(name, callback);
    video.getBoundingClientRect = () => ({ width: 100, height: 100 });
  }
  const messages = [];
  const runtimeListeners = [];
  const rangeCalls = [];
  const document = {
    documentElement: {},
    querySelectorAll(selector) { return selector === "video" ? videos : []; }
  };
  const context = vm.createContext({
    document,
    Element: class {},
    MutationObserver: class { observe() {} },
    window: { addEventListener() {} },
    chrome: { runtime: {
      onMessage: { addListener(callback) { runtimeListeners.push(callback); } },
      async sendMessage(message) {
        messages.push(message);
        return { ok: true, data: { topUrl: "https://test/", profileKey: "test", profile: initialProfile } };
      }
    } }
  });
  run("src/shared/constants.js", context);
  run("src/shared/time.js", context);
  run("src/content/range-executor.js", context);
  const originalExecuteRange = context.OpenDSkipper.RangeExecutor.executeRange;
  context.OpenDSkipper.RangeExecutor = {
    executeRange(...args) {
      rangeCalls.push(args[1].id);
      return originalExecuteRange(...args);
    }
  };
  run("src/content/video-skipper.js", context);
  return {
    listeners: listenerMaps.get(videos[0]),
    listenersFor: (video) => listenerMaps.get(video),
    runtimeListeners,
    rangeCalls,
    messages,
    context
  };
}

async function flush() {
  await new Promise((resolve) => setImmediate(resolve));
}

test("Easy opening and ending keep one-shot and replay/source reset behavior", async () => {
  const video = {
    currentTime: 0,
    duration: 100,
    readyState: 1,
    paused: false,
    ended: false,
    src: "first"
  };
  const { listeners } = contentHarness({ enabled: true, skipStart: 10.25, skipEnd: 5 }, video);
  await flush();
  assert.equal(video.currentTime, 10.25);
  video.currentTime = 1;
  listeners.get("timeupdate")();
  assert.equal(video.currentTime, 1); // Opening already handled.
  video.currentTime = 96;
  listeners.get("timeupdate")();
  assert.equal(video.currentTime, 99.95);
  video.currentTime = 97;
  listeners.get("timeupdate")();
  assert.equal(video.currentTime, 97); // Ending already handled.
  listeners.get("ended")();
  video.currentTime = 0;
  listeners.get("playing")();
  assert.equal(video.currentTime, 10.25);
  video.src = "second";
  video.currentTime = 0;
  listeners.get("timeupdate")();
  assert.equal(video.currentTime, 10.25);
  video.currentTime = 0;
  listeners.get("loadedmetadata")();
  listeners.get("timeupdate")();
  assert.equal(video.currentTime, 10.25);
  video.currentTime = 0;
  listeners.get("emptied")();
  listeners.get("timeupdate")();
  assert.equal(video.currentTime, 10.25);
});

test("unknown duration allows opening and disables ending; iframe state retains precision", async () => {
  const video = {
    currentTime: 0,
    duration: Infinity,
    readyState: 1,
    paused: false,
    ended: false,
    src: "iframe"
  };
  const { listeners, runtimeListeners, messages } = contentHarness(
    { enabled: true, skipStart: 84.732, skipEnd: 5 }, video
  );
  await flush();
  assert.equal(video.currentTime, 84.732);
  video.currentTime = 200;
  listeners.get("timeupdate")();
  assert.equal(video.currentTime, 200);
  runtimeListeners[0]({ type: "video:request-state", requestId: "a" });
  await flush();
  const report = messages.find((message) => message.type === "video:report-state");
  assert.equal(report.video.currentTime, 200);
  assert.equal(report.video.duration, null);
  assert.equal(typeof report.video.lastActivity, "number");
  assert.ok(report.video.lastActivity > 1e12); // Wall-clock milliseconds stay separate.
});

test("profile changes reset one-shot state for an already playing video", async () => {
  const video = {
    currentTime: 0,
    duration: 100,
    readyState: 1,
    paused: false,
    ended: false,
    src: "first"
  };
  const { listeners, runtimeListeners } = contentHarness(
    { enabled: true, skipStart: 10, skipEnd: 0 }, video
  );
  await flush();
  assert.equal(video.currentTime, 10);
  video.currentTime = 0;
  listeners.get("timeupdate")();
  assert.equal(video.currentTime, 0);
  runtimeListeners[0]({
    type: "profile:updated",
    topUrl: "https://test/",
    profileKey: "test",
    profile: { enabled: true, skipStart: 12, skipEnd: 0 }
  });
  assert.equal(video.currentTime, 12);
});

test("overlapping Easy opening and ending seek on successive playback events", async () => {
  for (const skipEnd of [50, 40]) { // Greater than and equal to duration.
    const video = {
      currentTime: 0,
      duration: 100,
      readyState: 1,
      paused: false,
      ended: false,
      src: `overlap-${skipEnd}`
    };
    const { listeners, rangeCalls } = contentHarness(
      { enabled: true, skipStart: 60, skipEnd }, video
    );
    await flush();
    assert.equal(video.currentTime, 60);
    listeners.get("timeupdate")();
    assert.equal(video.currentTime, 99.95);
    assert.deepEqual(rangeCalls, ["easy-opening", "easy-ending"]);
    video.currentTime = 60;
    listeners.get("timeupdate")();
    assert.equal(video.currentTime, 60); // Both Easy skips were already handled.
  }
});

test("Easy opening marks an already passed range and never seeks backward", async () => {
  const video = {
    currentTime: 20,
    duration: 100,
    readyState: 1,
    paused: false,
    ended: false,
    src: "already-past"
  };
  const { listeners, rangeCalls } = contentHarness(
    { enabled: true, skipStart: 10, skipEnd: 0 }, video
  );
  await flush();
  assert.equal(video.currentTime, 20);
  video.currentTime = 1;
  listeners.get("timeupdate")();
  assert.equal(video.currentTime, 1);
  assert.deepEqual(rangeCalls, []);
});

test("Easy opening waits for metadata without marking its range handled", async () => {
  const video = {
    currentTime: 0,
    duration: NaN,
    readyState: 0,
    paused: false,
    ended: false,
    src: "waiting"
  };
  const { listeners, rangeCalls } = contentHarness(
    { enabled: true, skipStart: 10.25, skipEnd: 5 }, video
  );
  await flush();
  assert.equal(video.currentTime, 0);
  assert.deepEqual(rangeCalls, []);
  video.readyState = 1;
  listeners.get("timeupdate")();
  assert.equal(video.currentTime, 10.25);
  assert.deepEqual(rangeCalls, ["easy-opening"]);
});

test("Easy ending uses shared range only during playback with finite duration", async () => {
  const video = {
    currentTime: 96,
    duration: 100,
    readyState: 1,
    paused: true,
    ended: false,
    src: "paused-ending"
  };
  const { listeners, rangeCalls } = contentHarness(
    { enabled: true, skipStart: 0, skipEnd: 5 }, video
  );
  await flush();
  listeners.get("timeupdate")();
  assert.equal(video.currentTime, 96);
  assert.deepEqual(rangeCalls, []);
  video.paused = false;
  listeners.get("playing")();
  assert.equal(video.currentTime, 99.95);
  assert.deepEqual(rangeCalls, ["easy-ending"]);
  video.currentTime = 96;
  listeners.get("timeupdate")();
  assert.equal(video.currentTime, 96);
});

test("Easy ending within the last 50 ms completes without a backward seek", async () => {
  const video = {
    currentTime: 99.98,
    duration: 100,
    readyState: 1,
    paused: false,
    ended: false,
    src: "natural-end"
  };
  const { listeners, rangeCalls } = contentHarness(
    { enabled: true, skipStart: 0, skipEnd: 5 }, video
  );
  await flush();
  assert.equal(video.currentTime, 99.98);
  video.currentTime = 96;
  listeners.get("timeupdate")();
  assert.equal(video.currentTime, 96);
  assert.deepEqual(rangeCalls, []);
});

test("two video elements keep independent handled ranges", async () => {
  const first = { currentTime: 0, duration: 100, readyState: 1, paused: false, ended: false, src: "a" };
  const second = { currentTime: 0, duration: 100, readyState: 1, paused: false, ended: false, src: "b" };
  const harness = contentHarness(
    { enabled: true, skipStart: 10, skipEnd: 5 }, [first, second]
  );
  await flush();
  assert.equal(first.currentTime, 10);
  assert.equal(second.currentTime, 10);
  first.currentTime = 96;
  harness.listenersFor(first).get("timeupdate")();
  assert.equal(first.currentTime, 99.95);
  assert.equal(second.currentTime, 10);
  second.currentTime = 96;
  harness.listenersFor(second).get("timeupdate")();
  assert.equal(second.currentTime, 99.95);
  first.currentTime = 1;
  harness.listenersFor(first).get("timeupdate")();
  assert.equal(first.currentTime, 1);
});

function popupHarness(initialProfile, videoState, options = {}) {
  const html = fs.readFileSync(path.join(root, "src/popup/popup.html"), "utf8");
  const ids = Array.from(html.matchAll(/\bid="([^"]+)"/g), (match) => match[1]);
  function element() {
    const listeners = new Map();
    const attributes = new Map();
    return {
      value: "",
      textContent: "",
      checked: false,
      disabled: false,
      inert: false,
      hidden: false,
      classList: { toggle() {} },
      addEventListener(name, callback) { listeners.set(name, callback); },
      async fire(name) { await listeners.get(name)(); },
      setAttribute(name, value) { attributes.set(name, value); },
      getAttribute(name) { return attributes.get(name); },
      replaceChildren() {},
      append() {},
      querySelectorAll() { return []; }
    };
  }
  const elements = Object.fromEntries(ids.map((id) => [id, element()]));
  let profile = { ...initialProfile };
  let copied = null;
  const calls = [];
  const queries = [];
  let releaseContext;
  const contextGate = options.deferContext
    ? new Promise((resolve) => { releaseContext = resolve; })
    : null;
  const contextFor = () => ({
    topUrl: "https://test/",
    profileKey: "test",
    profile,
    exists: true,
    urlFixerSettings: { schemaVersion: 1, rules: [] }
  });
  const context = vm.createContext({
    document: {
      getElementById(id) { return elements[id]; },
      createElement() { return element(); }
    },
    chrome: {
      tabs: { async query(query) {
        queries.push(query);
        return query.currentWindow
          ? (options.currentTabs ?? [{ id: 1, url: "https://test/" }])
          : (options.focusedTabs ?? []);
      } },
      runtime: { async sendMessage(message) {
        calls.push(message);
        let data;
        switch (message.type) {
          case "profile:get-popup-context":
            if (contextGate) await contextGate;
            if (options.failContext) return { ok: false, error: "Контекст вкладки недоступний." };
            data = contextFor();
            break;
          case "skip-buffer:get": data = { settings: copied }; break;
          case "profile:save-for-tab":
            profile = { ...message.profile };
            data = contextFor();
            break;
          case "skip-buffer:copy": copied = { ...message.settings }; data = { settings: copied }; break;
          case "skip-buffer:paste-for-tab":
            profile = { ...profile, ...copied };
            data = contextFor();
            break;
          case "video:collect-state": data = { video: videoState }; break;
          default: throw new Error(`Unexpected message: ${message.type}`);
        }
        return { ok: true, data };
      } }
    }
  });
  run("src/shared/constants.js", context);
  run("src/shared/time.js", context);
  context.OpenDSkipper.UrlFixers = {
    OPERATION: {
      TRUNCATE_AFTER: "truncateAfter",
      TRUNCATE_AFTER_LAST: "truncateAfterLast",
      REMOVE_EXACT: "removeExact",
      REPLACE_EXACT: "replaceExact"
    },
    POSITION: { START: "start", END: "end", ANYWHERE: "anywhere" },
    MAX_RULES: 10,
    applyUrlFixers(url) { return { profileKey: url, warning: null }; }
  };
  run("src/popup/popup.js", context);
  return {
    elements, calls, queries, releaseContext,
    get profile() { return profile; },
    get copied() { return copied; }
  };
}

test("popup loads old values, preserves fractions, and resets them on native edits", async () => {
  const popup = popupHarness(
    { enabled: true, skipStart: 84.732, skipEnd: 91.125 },
    { currentTime: 84.732, duration: 1432.428 }
  );
  await flush();
  const { elements } = popup;
  assert.equal(elements.skipStart.value, "00:01:24");
  assert.equal(elements.skipStartFraction.textContent, ".732");
  assert.equal(elements.skipEndFraction.textContent, ".125");
  await elements.save.fire("click");
  assert.equal(popup.profile.skipStart, 84.732);
  assert.equal(popup.profile.skipEnd, 91.125);
  await elements.copySkipSettings.fire("click");
  assert.equal(popup.copied.skipStart, 84.732);
  await elements.pasteSkipSettings.fire("click");
  assert.equal(popup.profile.skipEnd, 91.125);

  elements.skipStart.value = "00:01:25"; // Value produced by native stepper +1.
  await elements.skipStart.fire("input");
  assert.equal(elements.skipStartFraction.textContent, ".000");
  await elements.save.fire("click");
  assert.equal(popup.profile.skipStart, 85);
  assert.equal(popup.profile.skipEnd, 91.125);
  elements.skipEnd.value = "00:01:32";
  await elements.skipEnd.fire("change");
  await elements.save.fire("click");
  assert.equal(popup.profile.skipEnd, 92);
});

test("popup current and remaining actions retain media precision", async () => {
  const popup = popupHarness(
    { enabled: true, skipStart: 0, skipEnd: 0 },
    { currentTime: 84.732, duration: 1432.428 }
  );
  await flush();
  await popup.elements.useCurrentStart.fire("click");
  assert.equal(popup.elements.skipStart.value, "00:01:24");
  assert.equal(popup.elements.skipStartFraction.textContent, ".732");
  await popup.elements.useCurrentEnd.fire("click");
  assert.equal(popup.elements.skipEnd.value, "00:22:27");
  assert.equal(popup.elements.skipEndFraction.textContent, ".696");
  await popup.elements.save.fire("click");
  assert.equal(popup.profile.skipStart, 84.732);
  assert.ok(Math.abs(popup.profile.skipEnd - 1347.696) < 1e-9);
});

test("popup DOM IDs match JS and loading locks every context action", async () => {
  const html = fs.readFileSync(path.join(root, "src/popup/popup.html"), "utf8");
  const js = fs.readFileSync(path.join(root, "src/popup/popup.js"), "utf8");
  const htmlIds = new Set(Array.from(html.matchAll(/\bid="([^"]+)"/g), (match) => match[1]));
  const scriptIds = Array.from(js.matchAll(/document\.getElementById\("([^"]+)"\)/g), (match) => match[1]);
  assert.deepEqual(scriptIds.filter((id) => !htmlIds.has(id)), []);
  assert.match(html, /<main id="popupContent" inert/);

  const popup = popupHarness(
    { enabled: true, skipStart: 84.732, skipEnd: 0 },
    null,
    { deferContext: true }
  );
  assert.equal(popup.elements.popupContent.inert, true);
  assert.equal(popup.elements.popupOverlay.hidden, false);
  assert.equal(popup.elements.popupSpinner.hidden, false);
  for (const id of ["enabled", "skipStart", "skipEnd", "useCurrentStart", "useCurrentEnd",
    "save", "copySkipSettings", "pasteSkipSettings", "urlFixerControls", "addUrlFixer"]) {
    assert.equal(popup.elements[id].disabled, true, id);
  }
  await popup.elements.useCurrentStart.fire("click");
  assert.equal(popup.calls.some((call) => call.type === "video:collect-state"), false);
  assert.equal(popup.elements.useCurrentStart.disabled, true);
  await flush();
  assert.equal(popup.calls.find((call) => call.type === "profile:get-popup-context").tabId, 1);
  popup.releaseContext();
  await flush();
  assert.equal(popup.elements.popupContent.inert, false);
  assert.equal(popup.elements.popupOverlay.hidden, true);
  assert.equal(popup.elements.pageUrl.textContent, "https://test/");
  assert.equal(popup.elements.skipStart.disabled, false);
  assert.equal(popup.elements.addUrlFixer.disabled, false);
});

test("popup fallback finds a valid tab and terminal failures never send a null tab ID", async () => {
  const profile = { enabled: true, skipStart: 0, skipEnd: 0 };
  const fallback = popupHarness(profile, null, {
    currentTabs: [{ id: undefined, url: "https://test/" }],
    focusedTabs: [{ id: 42, url: "https://test/" }]
  });
  await flush();
  assert.equal(fallback.calls.find((call) => call.type === "profile:get-popup-context").tabId, 42);
  assert.equal(fallback.elements.popupOverlay.hidden, true);

  const unavailable = popupHarness(profile, null, { currentTabs: [], focusedTabs: [] });
  await flush();
  assert.equal(unavailable.calls.some((call) => call.type === "profile:get-popup-context"), false);
  assert.equal(unavailable.elements.popupContent.inert, true);
  assert.equal(unavailable.elements.popupSpinner.hidden, true);
  assert.match(unavailable.elements.popupOverlayMessage.textContent, /Немає доступної активної вкладки/);
  assert.equal(unavailable.elements.useCurrentStart.disabled, true);
  assert.equal(unavailable.elements.addUrlFixer.disabled, true);

  const rejected = popupHarness(profile, null, { failContext: true });
  await flush();
  assert.equal(rejected.calls.find((call) => call.type === "profile:get-popup-context").tabId, 1);
  assert.equal(rejected.elements.popupContent.inert, true);
  assert.equal(rejected.elements.popupSpinner.hidden, true);
  assert.match(rejected.elements.popupOverlayMessage.textContent, /Контекст вкладки недоступний/);
});

test("existing sync profile and local copy buffer keep fractional seconds", async () => {
  const sync = new Map();
  const local = new Map();
  const store = (map) => ({
    async get(key) { return { [key]: map.get(key) }; },
    async set(values) { for (const [key, value] of Object.entries(values)) map.set(key, value); },
    async remove(keys) { for (const key of keys) map.delete(key); }
  });
  const context = vm.createContext({
    crypto: require("node:crypto").webcrypto,
    TextEncoder,
    chrome: { storage: { sync: store(sync), local: store(local) } }
  });
  run("src/shared/constants.js", context);
  run("src/shared/profiles.js", context);
  const profiles = context.OpenDSkipper.Profiles;
  const url = "https://test/";
  await profiles.saveProfile(url, { enabled: true, skipStart: 84.732, skipEnd: 91.125 });
  const key = [...sync.keys()][0];
  assert.match(key, /^profile:v1:/);
  assert.equal(sync.get(key).profile.skipStart, 84.732);
  assert.equal((await profiles.loadProfile(url)).profile.skipEnd, 91.125);
  await profiles.copySkipSettings({ skipStart: 84.732, skipEnd: 91.125 });
  assert.equal(local.get("copiedSkipSettings").skipStart, 84.732);
  assert.equal((await profiles.getCopiedSkipSettings()).skipEnd, 91.125);
});
