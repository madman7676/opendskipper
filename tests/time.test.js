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

function contentHarness(initialProfile, videoOrVideos, initialAdvanced = null) {
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
        return { ok: true, data: {
          topUrl: "https://test/", profileKey: "test", profile: initialProfile,
          advanced: initialAdvanced
        } };
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

test("runtime executes only selected mode via shared range executor and resets on updates", async () => {
  const video = {
    currentTime: 0, duration: 300, readyState: 1,
    paused: false, ended: false, src: "advanced-test"
  };
  const profile = { enabled: true, skipStart: 10, skipEnd: 0 };
  const advanced = {
    mode: "easy", currentEpisode: "1",
    ranges: [{ key: "0:2000", start: 0, end: 20 }]
  };
  const { listeners, runtimeListeners, rangeCalls } = contentHarness(profile, video, advanced);
  await flush();
  assert.equal(video.currentTime, 10);
  assert.deepEqual(rangeCalls, ["easy-opening"]);
  const update = (nextAdvanced) => runtimeListeners[0]({
    type: "profile:updated", topUrl: "https://test/", profileKey: "test",
    profile, advanced: nextAdvanced
  });
  video.currentTime = 0;
  update({ ...advanced, mode: "advanced" });
  assert.equal(video.currentTime, 20);
  assert.equal(rangeCalls.at(-1), "advanced:1:0:2000");
  video.currentTime = 0;
  listeners.get("timeupdate")();
  assert.equal(video.currentTime, 0); // Handled until episode or ranges change.
  update({ mode: "advanced", currentEpisode: "2", ranges: [
    { key: "0:2000", start: 0, end: 20 }
  ] });
  assert.equal(video.currentTime, 20);
  assert.equal(rangeCalls.at(-1), "advanced:2:0:2000");
  video.currentTime = 0;
  update({ mode: "advanced", currentEpisode: "2", ranges: [
    { key: "0:3000", start: 0, end: 30 }
  ] });
  assert.equal(video.currentTime, 30); // Saved edit/add/delete broadcast resets handled.
  video.currentTime = 0;
  update(advanced);
  assert.equal(video.currentTime, 10);
  assert.equal(rangeCalls.at(-1), "easy-opening");
});

test("global enabled gates both modes and re-enabling uses the current mode", async () => {
  const video = {
    currentTime: 0, duration: 300, readyState: 1,
    paused: false, ended: false, src: "global-enabled"
  };
  const easy = { mode: "easy", currentEpisode: "1", ranges: [
    { key: "0:2000", start: 0, end: 20 }
  ] };
  const advanced = { ...easy, mode: "advanced" };
  const disabled = { enabled: false, skipStart: 10, skipEnd: 0 };
  const enabled = { ...disabled, enabled: true };
  const harness = contentHarness(disabled, video, easy);
  await flush();
  assert.equal(video.currentTime, 0);
  assert.deepEqual(harness.rangeCalls, []);
  const update = (profile, mode) => harness.runtimeListeners[0]({
    type: "profile:updated", topUrl: "https://test/", profileKey: "test",
    profile, advanced: mode
  });
  update(disabled, advanced);
  assert.equal(video.currentTime, 0);
  assert.deepEqual(harness.rangeCalls, []);
  update(enabled, advanced);
  assert.equal(video.currentTime, 20);
  assert.deepEqual(harness.rangeCalls, ["advanced:1:0:2000"]);
  video.currentTime = 0;
  update(disabled, advanced);
  assert.equal(video.currentTime, 0);
  harness.listeners.get("timeupdate")();
  assert.equal(video.currentTime, 0);
  update(disabled, easy);
  assert.equal(video.currentTime, 0);
  update(enabled, easy);
  assert.equal(video.currentTime, 10);
  assert.equal(harness.rangeCalls.at(-1), "easy-opening");
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
      children: [],
      dataset: {},
      classList: { toggle() {} },
      addEventListener(name, callback) {
        listeners.set(name, [...(listeners.get(name) || []), callback]);
      },
      async fire(name) {
        for (const callback of listeners.get(name) || []) await callback();
      },
      setAttribute(name, value) { attributes.set(name, value); },
      getAttribute(name) { return attributes.get(name); },
      replaceChildren() { this.children = []; },
      append(...children) { this.children.push(...children); },
      focus() {},
      querySelectorAll() { return []; }
    };
  }
  const elements = Object.fromEntries(ids.map((id) => [id, element()]));
  let profile = { ...initialProfile };
  let advanced = { mode: "easy", currentEpisode: "1", timingKeys: [], ranges: [] };
  let copied = null;
  let currentVideo = videoState;
  let currentProfileKey = options.profileKey || "test";
  let fixerRules = [];
  const rawUrl = options.rawUrl || "https://test/";
  const calls = [];
  const queries = [];
  const timers = new Map();
  const intervals = new Map();
  let nextTimerId = 0;
  let releaseContext;
  const contextGate = options.deferContext
    ? new Promise((resolve) => { releaseContext = resolve; })
    : null;
  const contextFor = () => ({
    topUrl: rawUrl,
    profileKey: currentProfileKey,
    profile,
    advanced,
    exists: true,
    urlFixerWarning: options.urlFixerWarning || null,
    urlFixerSettings: { schemaVersion: 1, rules: fixerRules }
  });
  const context = vm.createContext({
    setTimeout(callback, delay) {
      const id = ++nextTimerId;
      timers.set(id, { callback, delay });
      return id;
    },
    clearTimeout(id) { timers.delete(id); },
    setInterval(callback, delay) {
      const id = ++nextTimerId;
      intervals.set(id, { callback, delay });
      return id;
    },
    clearInterval(id) { intervals.delete(id); },
    crypto: require("node:crypto").webcrypto,
    URL,
    confirm() { return true; },
    document: {
      getElementById(id) { return elements[id]; },
      createElement() { return element(); }
    },
    chrome: {
      storage: { local: {
        async get() { return {}; },
        async set() {}
      } },
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
            if (options.failSave) return { ok: false, error: "Збереження не вдалося." };
            profile = { ...message.profile };
            data = contextFor();
            break;
          case "advanced:set-mode":
            advanced = { ...advanced, mode: message.mode };
            data = contextFor();
            break;
          case "url-fixers:save-for-tab":
            fixerRules = message.rules;
            currentProfileKey = context.OpenDSkipper.UrlFixers.applyUrlFixers(rawUrl, fixerRules).profileKey;
            data = contextFor();
            break;
          case "skip-buffer:copy": copied = { ...message.settings }; data = { settings: copied }; break;
          case "skip-buffer:paste-for-tab":
            profile = { ...profile, ...copied };
            data = contextFor();
            break;
          case "video:collect-state": data = { video: currentVideo }; break;
          default: throw new Error(`Unexpected message: ${message.type}`);
        }
        return { ok: true, data };
      } }
    }
  });
  run("src/shared/constants.js", context);
  run("src/shared/time.js", context);
  run("src/shared/advanced.js", context);
  run("src/shared/url-fixers.js", context);
  run("src/popup/time-field.js", context);
  run("src/popup/advanced-ui.js", context);
  run("src/popup/popup.js", context);
  return {
    elements, calls, queries, releaseContext, timers, intervals,
    setVideo(value) { currentVideo = value; },
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
  const advancedJs = fs.readFileSync(path.join(root, "src/popup/advanced-ui.js"), "utf8");
  const htmlIds = new Set(Array.from(html.matchAll(/\bid="([^"]+)"/g), (match) => match[1]));
  const scriptIds = Array.from(js.matchAll(/document\.getElementById\("([^"]+)"\)/g), (match) => match[1]);
  assert.deepEqual(scriptIds.filter((id) => !htmlIds.has(id)), []);
  const advancedIds = advancedJs.match(/const ids = \[([\s\S]*?)\];/)[1]
    .match(/"[^"]+"/g).map((id) => id.slice(1, -1));
  assert.deepEqual(advancedIds.filter((id) => !htmlIds.has(id)), []);
  assert.match(html, /<main id="popupContent" inert/);

  const popup = popupHarness(
    { enabled: true, skipStart: 84.732, skipEnd: 0 },
    { currentTime: 84.732, duration: 1432.428 },
    { deferContext: true }
  );
  assert.equal(popup.elements.popupContent.inert, true);
  assert.equal(popup.elements.popupOverlay.hidden, false);
  assert.equal(popup.elements.popupSpinner.hidden, false);
  assert.equal(popup.elements.modeSwitch.disabled, true);
  assert.equal(popup.elements.advancedSection.inert, true);
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
  assert.equal(popup.elements.pageUrl.textContent, "test");
  assert.equal(popup.elements.skipStart.disabled, false);
  assert.equal(popup.elements.modeSwitch.disabled, false);
  assert.equal(popup.elements.advancedSection.inert, false);
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

test("popup mode switch persists through worker message and changes visible section", async () => {
  const html = fs.readFileSync(path.join(root, "src/popup/popup.html"), "utf8");
  const css = fs.readFileSync(path.join(root, "src/popup/popup.css"), "utf8");
  assert.match(html, /id="modeSwitch" type="checkbox" role="switch" aria-label="Advanced mode"/);
  assert.match(css, /input:checked \+ \.mode-track \.mode-thumb\s*\{[^}]*translateX/s);
  assert.match(css, /input:focus-visible \+ \.mode-track/);
  const popup = popupHarness({ enabled: true, skipStart: 10, skipEnd: 2 }, null);
  await flush();
  assert.equal(popup.elements.easySection.hidden, false);
  assert.equal(popup.elements.advancedSection.hidden, true);
  popup.elements.modeSwitch.checked = true;
  await popup.elements.modeSwitch.fire("change");
  const message = popup.calls.find((call) => call.type === "advanced:set-mode");
  assert.equal(message.tabId, 1);
  assert.equal(message.expectedUrl, "https://test/");
  assert.equal(message.mode, "advanced");
  assert.equal(popup.elements.easySection.hidden, true);
  assert.equal(popup.elements.advancedSection.hidden, false);
  popup.elements.modeSwitch.checked = false;
  await popup.elements.modeSwitch.fire("change");
  assert.equal(popup.elements.easySection.hidden, false);
  assert.equal(popup.profile.skipStart, 10);
});

test("popup Enabled persists without changing mode or Easy settings", async () => {
  const popup = popupHarness({ enabled: false, skipStart: 10, skipEnd: 2 }, null);
  await flush();
  popup.elements.modeSwitch.checked = true;
  await popup.elements.modeSwitch.fire("change");
  assert.equal(popup.profile.enabled, false);
  popup.elements.skipStart.value = "00:00:30";
  await popup.elements.skipStart.fire("change"); // Unsaved Easy edit must not leak into Enabled save.
  popup.elements.enabled.checked = true;
  await popup.elements.enabled.fire("change");
  const saved = popup.calls.filter((call) => call.type === "profile:save-for-tab").at(-1);
  assert.equal(saved.profile.enabled, true);
  assert.equal(saved.profile.skipStart, 10);
  assert.equal(saved.profile.skipEnd, 2);
  assert.equal(popup.elements.modeSwitch.checked, true);
  assert.equal(popup.elements.advancedSection.hidden, false);
  assert.equal(popup.profile.enabled, true);
  assert.equal(popup.calls.some((call) => call.type === "advanced:set-mode"), true);
});

test("popup header, service area, and semantic actions have the intended hierarchy", () => {
  const html = fs.readFileSync(path.join(root, "src/popup/popup.html"), "utf8");
  const css = fs.readFileSync(path.join(root, "src/popup/popup.css"), "utf8");
  assert.match(html, /<header class="popup-header">\s*<h1>OpEndSkipper<\/h1>\s*<label class="toggle global-enabled">\s*<span>Увімкнено<\/span>\s*<input id="enabled"/);
  assert.match(html, /<div class="service-area">[\s\S]*id="pageUrl"[\s\S]*Advanced mode[\s\S]*id="modeSwitch"/);
  assert.match(html, /id="mainSettings"[\s\S]*id="easySection"[\s\S]*id="advancedSection"[\s\S]*id="settingsOverlay"[\s\S]*id="urlFixerSection"/);
  assert.match(css, /\.popup-header\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\) auto/s);
  assert.match(css, /\.service-area\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\) auto/s);
  assert.match(css, /\.mode-control\s*\{[^}]*width:\s*38px;[^}]*height:\s*20px/s);
  assert.match(css, /\.mode-control input:checked \+ \.mode-track\s*\{[^}]*#5f9a75/s);
  assert.match(css, /\.mode-track\s*\{[^}]*#a26065/s);
  for (const [id, semanticClass] of [
    ["saveAdvancedRanges", "semantic-save-set"],
    ["cancelAdvancedRanges", "semantic-cancel-set"],
    ["applyAdvancedEdit", "semantic-apply-draft"],
    ["cancelAdvancedEdit", "semantic-cancel-draft"]
  ]) {
    assert.match(html, new RegExp(`id="${id}"[^>]*class="[^"]*${semanticClass}`));
    assert.match(css, new RegExp(`\\.${semanticClass}\\s*\\{[^}]*border-color:`));
  }
  assert.match(css, /\.semantic-cancel-draft\s*\{[^}]*background:\s*transparent/s);
  assert.match(css, /\.range-icon\s*\{[^}]*border:\s*0;[^}]*background:\s*transparent/s);
  assert.match(css, /\.toast-layer\s*\{[^}]*position:\s*fixed;[^}]*z-index:\s*3/s);
  assert.match(css, /\.toast-layer\s*\{[^}]*top:\s*10px/s);
  assert.match(css, /\.settings-overlay\s*\{[^}]*z-index:\s*2/s);
  assert.match(css, /body\s*\{[^}]*overflow-x:\s*hidden/s);
  assert.match(css, /\.page-url\s*\{[^}]*overflow-wrap:\s*anywhere/s);
  assert.match(css, /\.templates-title::before\s*\{[^}]*▶/s);
  assert.match(css, /\.templates-section\[open\] \.templates-title::before\s*\{[^}]*▼/s);
});

test("no video blocks only settings, then polling unlocks them when video appears", async () => {
  const popup = popupHarness({ enabled: true, skipStart: 12, skipEnd: 3 }, null);
  await flush();
  const { elements: e } = popup;
  assert.equal(e.popupOverlay.hidden, true);
  assert.equal(e.popupContent.inert, false);
  assert.equal(e.settingsOverlay.hidden, false);
  assert.equal(e.settingsOverlayMessage.textContent, "Відео на сторінці не знайдено");
  assert.equal(e.mainSettingsContent.inert, true);
  assert.equal(e.advancedSection.inert, true);
  for (const id of ["skipStart", "skipEnd", "useCurrentStart", "useCurrentEnd", "save", "copySkipSettings"]) {
    assert.equal(e[id].disabled, true, id);
  }
  assert.equal(e.enabled.disabled, false);
  assert.equal(e.modeSwitch.disabled, false);
  assert.equal(e.urlFixerControls.disabled, false);
  assert.equal(e.addUrlFixer.disabled, false);
  e.modeSwitch.checked = true;
  await e.modeSwitch.fire("change");
  assert.equal(e.advancedSection.hidden, false);
  assert.equal(e.mainSettingsContent.inert, true);
  e.enabled.checked = false;
  await e.enabled.fire("change");
  assert.equal(popup.profile.enabled, false);
  popup.setVideo({ currentTime: 17.5, duration: 100 });
  assert.equal(popup.intervals.size, 1);
  await popup.intervals.values().next().value.callback();
  await flush();
  assert.equal(e.settingsOverlay.hidden, true);
  assert.equal(e.mainSettingsContent.inert, false);
  assert.equal(e.advancedSection.inert, false);
  assert.equal(e.skipStart.disabled, false);
});

test("top key uses normalized profile key and updates immediately after fixer save", async () => {
  const rawUrl = "https://test.example/watch/c/123";
  const popup = popupHarness({ enabled: true, skipStart: 0, skipEnd: 0 }, null, {
    rawUrl, profileKey: rawUrl
  });
  await flush();
  const { elements: e } = popup;
  assert.equal(e.pageUrl.textContent, rawUrl);
  assert.equal(e.previewOriginalUrl.textContent, rawUrl);
  await e.addUrlFixer.fire("click");
  const form = e.addFixerForm.children[0];
  const value = form.children[1].children[0].children[0];
  value.value = "/123";
  await value.fire("input");
  const save = form.children[2].children[1];
  await save.fire("click");
  assert.equal(popup.calls.find((call) => call.type === "url-fixers:save-for-tab").tabId, 1);
  assert.equal(e.pageUrl.textContent, "https://test.example/watch/c");
  assert.equal(e.previewOriginalUrl.textContent, rawUrl);
  assert.equal(e.previewProfileKey.textContent, "https://test.example/watch/c");
});

test("service worker broadcasts mode and Enabled changes without navigation", async () => {
  const sync = new Map();
  const local = new Map();
  const broadcasts = [];
  let onMessage;
  const store = (map) => ({
    async get(keys) {
      const result = {};
      for (const key of Array.isArray(keys) ? keys : [keys]) result[key] = map.get(key);
      return result;
    },
    async set(values) {
      for (const [key, value] of Object.entries(values)) map.set(key, value);
    },
    async remove(keys) {
      for (const key of Array.isArray(keys) ? keys : [keys]) map.delete(key);
    }
  });
  const addListener = () => {};
  const context = vm.createContext({
    crypto: require("node:crypto").webcrypto,
    TextEncoder,
    URL,
    console,
    chrome: {
      runtime: {
        onMessage: { addListener(callback) { onMessage = callback; } },
        onInstalled: { addListener }, onStartup: { addListener }
      },
      tabs: {
        async sendMessage(tabId, message) { broadcasts.push({ tabId, message }); },
        async query() { return []; },
        onUpdated: { addListener }
      },
      webNavigation: {
        async getFrame() { return { url: "https://test/" }; },
        onHistoryStateUpdated: { addListener },
        onReferenceFragmentUpdated: { addListener }
      },
      storage: {
        sync: store(sync), local: store(local), onChanged: { addListener }
      }
    }
  });
  context.importScripts = (...files) => {
    for (const file of files) run(path.join("src/background", file), context);
  };
  run("src/background/service-worker.js", context);
  const send = (message) => new Promise((resolve) => {
    onMessage(message, {}, resolve);
  });
  const mode = await send({ type: "advanced:set-mode", tabId: 1,
    expectedUrl: "https://test/", mode: "advanced" });
  assert.equal(mode.ok, true);
  assert.equal(mode.data.advanced.mode, "advanced");
  assert.equal(mode.data.profile.enabled, false);
  assert.equal(broadcasts.at(-1).message.advanced.mode, "advanced");
  assert.equal(broadcasts.at(-1).message.profile.enabled, false);
  const enabled = await send({ type: "profile:save-for-tab", tabId: 1,
    expectedUrl: "https://test/", profile: { enabled: true, skipStart: 10, skipEnd: 2 } });
  assert.equal(enabled.ok, true);
  assert.equal(enabled.data.profile.enabled, true);
  assert.equal(enabled.data.advanced.mode, "advanced");
  assert.equal(broadcasts.at(-1).message.profile.enabled, true);
  assert.equal(broadcasts.at(-1).message.advanced.mode, "advanced");
  assert.ok(broadcasts.every(({ tabId, message }) =>
    tabId === 1 && message.type === "profile:updated"));
});

test("toast overlays content, replaces messages, closes, and dismisses after seven seconds", async () => {
  const html = fs.readFileSync(path.join(root, "src/popup/popup.html"), "utf8");
  const css = fs.readFileSync(path.join(root, "src/popup/popup.css"), "utf8");
  assert.ok(html.indexOf('id="toastLayer"') > html.indexOf("</main>"));
  assert.match(css, /\.toast-layer\s*\{[^}]*position:\s*fixed/s);
  assert.match(css, /\.toast-layer\s*\{[^}]*pointer-events:\s*none/s);
  assert.match(css, /\.toast\s*\{[^}]*pointer-events:\s*auto/s);
  const popup = popupHarness({ enabled: true, skipStart: 0, skipEnd: 0 }, null);
  await flush();
  assert.equal(popup.elements.toast.hidden, false);
  assert.equal(popup.elements.toast.getAttribute("data-type"), "info");
  assert.equal(popup.timers.size, 1);
  const firstTimer = [...popup.timers.keys()][0];
  await popup.elements.save.fire("click");
  assert.equal(popup.elements.toastMessage.textContent, "Налаштування збережено.");
  assert.equal(popup.elements.toast.getAttribute("data-type"), "success");
  assert.equal(popup.timers.has(firstTimer), false);
  assert.equal(popup.timers.size, 1);
  const [{ callback, delay }] = [...popup.timers.values()];
  assert.equal(delay, 7000);
  callback();
  assert.equal(popup.elements.toast.hidden, true);
  assert.equal(popup.timers.size, 0);
  await popup.elements.save.fire("click");
  assert.equal(popup.elements.toast.hidden, false);
  await popup.elements.toastClose.fire("click");
  assert.equal(popup.elements.toast.hidden, true);
  assert.equal(popup.timers.size, 0);
});

test("save and Advanced validation errors use the same accessible error toast", async () => {
  const failed = popupHarness({ enabled: true, skipStart: 0, skipEnd: 0 }, null,
    { failSave: true });
  await flush();
  await failed.elements.save.fire("click");
  assert.equal(failed.elements.toastMessage.textContent, "Збереження не вдалося.");
  assert.equal(failed.elements.toast.getAttribute("data-type"), "error");
  assert.equal(failed.elements.toast.getAttribute("role"), "alert");
  assert.equal(failed.elements.toast.getAttribute("aria-live"), "assertive");
  failed.elements.enabled.checked = false;
  await failed.elements.enabled.fire("change");
  assert.equal(failed.elements.enabled.checked, true);
  await failed.elements.addAdvancedRange.fire("click");
  await failed.elements.applyAdvancedEdit.fire("click");
  assert.match(failed.elements.toastMessage.textContent, /Діапазон/);
  assert.equal(failed.elements.toast.getAttribute("data-type"), "error");
});

test("URL fixer warning uses toast without inserting an inline message", async () => {
  const html = fs.readFileSync(path.join(root, "src/popup/popup.html"), "utf8");
  assert.doesNotMatch(html, /id="status"|id="urlFixerWarning"|class="field-error"/);
  const popup = popupHarness({ enabled: true, skipStart: 0, skipEnd: 0 }, null,
    { urlFixerWarning: "Не вдалося застосувати URL-фіксер." });
  await flush();
  assert.equal(popup.elements.toastMessage.textContent,
    "Не вдалося застосувати URL-фіксер.");
  assert.equal(popup.elements.toast.getAttribute("data-type"), "error");
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
