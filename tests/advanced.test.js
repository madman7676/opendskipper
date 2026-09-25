const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const root = path.resolve(__dirname, "..");
function run(file, context) {
  vm.runInContext(fs.readFileSync(path.join(root, file), "utf8"), context, { filename: file });
}

function storageHarness() {
  const sync = new Map();
  const local = new Map();
  const clone = (value) => value === undefined ? undefined : structuredClone(value);
  const store = (map) => ({
    async get(keys) {
      const result = {};
      for (const key of Array.isArray(keys) ? keys : [keys]) result[key] = clone(map.get(key));
      return result;
    },
    async set(values) {
      for (const [key, value] of Object.entries(values)) map.set(key, clone(value));
    },
    async remove(keys) {
      for (const key of Array.isArray(keys) ? keys : [keys]) map.delete(key);
    }
  });
  const context = vm.createContext({
    crypto: require("node:crypto").webcrypto,
    TextEncoder,
    chrome: { storage: { sync: store(sync), local: store(local) } }
  });
  for (const file of [
    "src/shared/constants.js", "src/shared/time.js", "src/shared/advanced.js",
    "src/shared/profiles.js", "src/background/advanced-storage.js"
  ]) run(file, context);
  return { ...context.OpenDSkipper, sync, local };
}

test("10 ms normalization uses Math.round and stable timing keys", () => {
  const { Advanced } = storageHarness();
  assert.equal(Advanced.normalizeTiming(84.734, 174.221).key, "8473:17422");
  assert.equal(Advanced.normalizeTiming(84.735, 174.221).key, "8474:17422");
  assert.equal(Advanced.normalizeTiming(84.736, 174.221).key, "8474:17422");
  assert.equal(Advanced.normalizeTiming(84.736, 174.229).key, "8474:17423");
  assert.equal(Advanced.makeTimingKey(84.736, 174.221), "8474:17422");
  assert.equal(Advanced.normalizeTiming(0, 0), null);
  assert.equal(Advanced.normalizeTiming(-1, 2), null);
  assert.equal(Advanced.normalizeTiming(NaN, 2), null);
});

test("per-profile mode and episode preserve Easy sync data", async () => {
  const { AdvancedStorage, Profiles, sync } = storageHarness();
  const a = "https://a.test/watch";
  const b = "https://b.test/watch";
  await Profiles.saveProfile(a, { enabled: true, skipStart: 84.732, skipEnd: 11 });
  const before = [...sync.values()][0];
  await AdvancedStorage.setMode(a, "advanced");
  await AdvancedStorage.setEpisode(a, "12");
  assert.equal((await AdvancedStorage.loadContext(a)).mode, "advanced");
  assert.equal((await AdvancedStorage.loadContext(a)).currentEpisode, "12");
  assert.equal((await AdvancedStorage.loadContext(b)).mode, "easy");
  await AdvancedStorage.setMode(a, "easy");
  assert.equal((await AdvancedStorage.loadContext(a)).currentEpisode, "12");
  assert.deepEqual([...sync.values()][0], before);
});

test("global pool reuses normalized timing across episodes and profiles", async () => {
  const { AdvancedStorage, ADVANCED_TIMING_POOL_KEY, local } = storageHarness();
  const a = "https://a.test";
  const b = "https://b.test";
  await AdvancedStorage.saveRanges(a, "1", [
    { start: 84.735, end: 174.221 }, { start: 84.736, end: 174.224 }
  ]);
  await AdvancedStorage.saveRanges(b, "1", [{ start: 84.736, end: 174.221 }]);
  const pool = local.get(ADVANCED_TIMING_POOL_KEY).timings;
  assert.equal(Object.keys(pool).length, 1);
  assert.deepEqual(pool["8474:17422"], { start: 84.74, end: 174.22 });
  assert.deepEqual(Array.from((await AdvancedStorage.loadContext(a)).timingKeys), ["8474:17422"]);
  assert.deepEqual(Array.from((await AdvancedStorage.loadContext(b)).timingKeys), ["8474:17422"]);
});

test("edit relinks only current episode; unlink keeps immutable timing", async () => {
  const { AdvancedStorage, ADVANCED_TIMING_POOL_KEY, local } = storageHarness();
  const url = "https://show.test";
  await AdvancedStorage.saveRanges(url, "1", [{ start: 0, end: 90 }]);
  await AdvancedStorage.setEpisode(url, "2");
  await AdvancedStorage.saveRanges(url, "2", [{ key: "0:9000" }]);
  await AdvancedStorage.saveRanges(url, "2", [{ start: 0, end: 91 }]);
  assert.deepEqual(Array.from((await AdvancedStorage.loadContext(url)).timingKeys), ["0:9100"]);
  await AdvancedStorage.setEpisode(url, "1");
  assert.deepEqual(Array.from((await AdvancedStorage.loadContext(url)).timingKeys), ["0:9000"]);
  await AdvancedStorage.saveRanges(url, "1", []);
  assert.equal((await AdvancedStorage.loadContext(url)).ranges.length, 0);
  const pool = local.get(ADVANCED_TIMING_POOL_KEY).timings;
  assert.deepEqual(pool["0:9000"], { start: 0, end: 90 });
  assert.deepEqual(pool["0:9100"], { start: 0, end: 91 });
});

test("existing timing is reused on edit; ranges resolve sorted by start and end", async () => {
  const { AdvancedStorage, ADVANCED_TIMING_POOL_KEY, local } = storageHarness();
  const url = "https://show.test";
  await AdvancedStorage.saveRanges(url, "1", [
    { start: 10, end: 20 }, { start: 0, end: 9 }, { start: 10, end: 19 }
  ]);
  const before = Object.keys(local.get(ADVANCED_TIMING_POOL_KEY).timings).length;
  await AdvancedStorage.saveRanges(url, "1", [{ start: 10, end: 19.001 }]);
  assert.equal(Object.keys(local.get(ADVANCED_TIMING_POOL_KEY).timings).length, before);
  await AdvancedStorage.saveRanges(url, "1", [
    { key: "1000:2000" }, { key: "0:900" }, { key: "1000:1900" }
  ]);
  assert.deepEqual(Array.from((await AdvancedStorage.loadContext(url)).timingKeys), [
    "0:900", "1000:1900", "1000:2000"
  ]);
});

test("invalid Save leaves episode and global pool unchanged", async () => {
  const { AdvancedStorage, ADVANCED_TIMING_POOL_KEY, local } = storageHarness();
  const url = "https://show.test";
  await AdvancedStorage.saveRanges(url, "1", [{ start: 0, end: 90 }]);
  const before = structuredClone(local.get(ADVANCED_TIMING_POOL_KEY));
  await assert.rejects(() => AdvancedStorage.saveRanges(url, "1", [
    { start: 10, end: 20 }, { start: 22, end: 22 }
  ]), /коректні/);
  assert.deepEqual(local.get(ADVANCED_TIMING_POOL_KEY), before);
  assert.deepEqual(Array.from((await AdvancedStorage.loadContext(url)).timingKeys), ["0:9000"]);
});

test("typed Advanced clipboard copies saved links and rejects Easy data", async () => {
  const { AdvancedStorage, Profiles, local, COPIED_SKIP_SETTINGS_KEY } = storageHarness();
  const a = "https://a.test";
  await AdvancedStorage.saveRanges(a, "1", [{ start: 0, end: 90 }]);
  await AdvancedStorage.copyRanges(a);
  assert.deepEqual(local.get(COPIED_SKIP_SETTINGS_KEY), {
    type: "advanced-range-set", timingKeys: ["0:9000"]
  });
  assert.deepEqual(Array.from((await AdvancedStorage.getClipboard()).map((range) => range.key)), ["0:9000"]);
  await Profiles.copySkipSettings({ skipStart: 4, skipEnd: 5 });
  assert.equal(local.get(COPIED_SKIP_SETTINGS_KEY).type, "easy-skip-settings");
  await assert.rejects(() => AdvancedStorage.getClipboard(), /Easy/);
  assert.deepEqual({ ...(await Profiles.getCopiedSkipSettings()) }, { skipStart: 4, skipEnd: 5 });
});

function uiHarness(
  video = { currentTime: 84.736, duration: 174.221 }, initialRanges = [], preferences = new Map()
) {
  const html = fs.readFileSync(path.join(root, "src/popup/popup.html"), "utf8");
  const ids = Array.from(html.matchAll(/\bid="([^"]+)"/g), (match) => match[1]);
  function element() {
    const listeners = new Map();
    const attributes = new Map();
    return {
      value: "", textContent: "", hidden: false, disabled: false, children: [],
      open: false,
      addEventListener(name, callback) { listeners.set(name, callback); },
      async fire(name, event = {}) { return listeners.get(name)(event); },
      setAttribute(name, value) { attributes.set(name, value); },
      getAttribute(name) { return attributes.get(name); },
      replaceChildren() { this.children = []; },
      append(child) { this.children.push(child); },
      focus() {}
    };
  }
  const elements = Object.fromEntries(ids.map((id) => [id, element()]));
  elements.advancedTemplates.open = true;
  const calls = [];
  const statuses = [];
  const context = vm.createContext({
    chrome: { storage: { local: {
      async get(key) { return { [key]: preferences.get(key) }; },
      async set(values) { for (const [key, value] of Object.entries(values)) preferences.set(key, value); }
    } } },
    document: {
      getElementById(id) { return elements[id]; },
      createElement() { return element(); }
    }
  });
  for (const file of [
    "src/shared/constants.js", "src/shared/time.js", "src/shared/advanced.js",
    "src/popup/time-field.js", "src/popup/advanced-ui.js"
  ]) run(file, context);
  let profileContext = {
    profileKey: "https://show.test", advanced: {
      mode: "advanced", currentEpisode: "1", ranges: initialRanges
    }
  };
  const api = context.OpenDSkipper;
  let ui;
  ui = api.AdvancedUi.create({
    async sendMessage(message) {
      calls.push(message);
      if (message.type === api.MESSAGE.GET_ADVANCED_CLIPBOARD) {
        return { ranges: [{ key: "0:9000", start: 0, end: 90 }] };
      }
      if (message.type === api.MESSAGE.SAVE_ADVANCED_RANGES) {
        profileContext = {
          ...profileContext,
          advanced: { ...profileContext.advanced, ranges: message.ranges.map((range) => {
            const normalized = range.key
              ? { key: range.key, start: 0, end: 90 }
              : api.Advanced.normalizeTiming(range.start, range.end);
            return normalized;
          }) }
        };
      }
      if (message.type === api.MESSAGE.SET_ADVANCED_EPISODE) {
        profileContext = {
          ...profileContext,
          advanced: { ...profileContext.advanced,
            currentEpisode: message.episodeId, ranges: [] }
        };
      }
      return profileContext;
    },
    async getVideoState() { return video; },
    setStatus(message, error) { statuses.push({ message, error }); },
    setBusy() {},
    getTabContext: () => ({ tabId: 1, topUrl: "https://show.test" }),
    applyContext(next, reset) { ui.render(next, reset); }
  });
  ui.render(profileContext, true);
  return { elements, calls, statuses, ui, preferences };
}

test("Advanced editor keeps precise current time in draft, normalizes only on Save, and Cancel is local", async () => {
  const { elements: e, calls, ui } = uiHarness();
  await e.addAdvancedRange.fire("click");
  await e.quickZeroCurrent.fire("click");
  assert.equal(e.advancedEndFraction.textContent, ".736");
  await e.applyAdvancedEdit.fire("click");
  assert.equal(ui.hasUnsavedChanges(), true);
  assert.equal(calls.length, 0);
  assert.match(e.advancedRangeList.children[0].children[0].textContent, /00:01:24\.736/);
  await e.cancelAdvancedRanges.fire("click");
  assert.equal(ui.hasUnsavedChanges(), false);
  assert.equal(calls.length, 0);
  await e.addAdvancedRange.fire("click");
  await e.quickZeroCurrent.fire("click");
  await e.applyAdvancedEdit.fire("click");
  await e.saveAdvancedRanges.fire("click");
  assert.equal(calls[0].type, "advanced:save-ranges");
  assert.equal(calls[0].ranges[0].end, 84.736); // Raw draft sent to storage boundary.
  assert.match(e.advancedRangeList.children[0].children[0].textContent, /00:01:24\.740/);
});

test("Advanced quick actions and Paste replace draft without storage writes", async () => {
  const { elements: e, calls } = uiHarness();
  await e.addAdvancedRange.fire("click");
  await e.quickZeroNinety.fire("click");
  assert.equal(e.advancedStart.value, "00:00:00");
  assert.equal(e.advancedEnd.value, "00:01:30");
  await e.quickCurrentNinety.fire("click");
  assert.equal(e.advancedStartFraction.textContent, ".736");
  assert.equal(e.advancedEndFraction.textContent, ".736");
  await e.quickCurrentEnd.fire("click");
  assert.equal(e.advancedEndFraction.textContent, ".221");
  await e.quickZeroCurrent.fire("click");
  assert.equal(e.advancedStart.value, "00:00:00");
  await e.cancelAdvancedEdit.fire("click");
  await e.pasteAdvancedRanges.fire("click");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].type, "advanced:get-clipboard");
  assert.match(e.advancedRangeList.children[0].children[0].textContent, /00:01:30\.000/);
});

test("Advanced row edit and delete change only the local draft until Save", async () => {
  const { elements: e, calls, ui } = uiHarness(
    { currentTime: 84.736, duration: 174.221 },
    [{ key: "0:9000", start: 0, end: 90 }]
  );
  await e.advancedRangeList.children[0].children[1].children[0].fire("click");
  await e.quickCurrentEnd.fire("click");
  await e.applyAdvancedEdit.fire("click");
  assert.equal(calls.length, 0);
  assert.equal(ui.hasUnsavedChanges(), true);
  assert.match(e.advancedRangeList.children[0].children[0].textContent, /00:02:54\.221/);
  await e.saveAdvancedRanges.fire("click");
  assert.deepEqual({ ...calls[0].ranges[0] }, { start: 84.736, end: 174.221 });
  await e.advancedRangeList.children[0].children[1].children[1].fire("click");
  assert.equal(calls.length, 1);
  assert.equal(e.advancedRangeList.children.length, 1);
  assert.equal(e.advancedRangeList.children[0].textContent, "Діапазонів поки немає.");
  await e.saveAdvancedRanges.fire("click");
  assert.deepEqual(Array.from(calls[1].ranges), []);
});

test("manual episode selection sends tab context and loads that episode", async () => {
  const { elements: e, calls, ui } = uiHarness();
  e.advancedEpisode.value = "12";
  await e.selectAdvancedEpisode.fire("click");
  assert.equal(calls[0].type, "advanced:set-episode");
  assert.equal(calls[0].tabId, 1);
  assert.equal(calls[0].expectedUrl, "https://show.test");
  assert.equal(calls[0].episodeId, "12");
  assert.equal(e.advancedEpisode.value, "12");
  assert.equal(ui.hasUnsavedChanges(), false);
});

test("range row uses two accessible icon actions and Copy targets the whole set", async () => {
  const { elements: e, calls } = uiHarness(
    undefined,
    [{ key: "0:9000", start: 0, end: 90 }]
  );
  const row = e.advancedRangeList.children[0];
  assert.equal(row.className, "advanced-range");
  assert.equal(row.children[0].textContent, "00:00:00.000 → 00:01:30.000");
  const actions = row.children[1].children;
  assert.equal(actions.length, 2);
  assert.equal(actions[0].className, "range-icon range-edit");
  assert.equal(actions[1].className, "range-icon range-delete");
  assert.equal(actions[0].title, "Редагувати діапазон");
  assert.equal(actions[1].getAttribute("aria-label"), "Видалити діапазон");
  assert.match(actions[0].innerHTML, /<svg/);
  assert.match(actions[1].innerHTML, /<svg/);
  await e.copyAdvancedRanges.fire("click");
  assert.equal(calls[0].type, "advanced:copy-ranges");
  assert.equal(calls[0].selectedKey, null);
});

test("Templates start expanded and their global preference survives reopen and episode changes", async () => {
  const preferences = new Map();
  const first = uiHarness(undefined, [], preferences);
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(first.elements.advancedTemplates.open, true);
  await first.elements.advancedTemplatesSummary.fire("click");
  first.elements.advancedTemplates.open = false;
  await first.elements.advancedTemplates.fire("toggle");
  assert.equal(preferences.get("popupTemplatesOpen:v1"), false);
  const second = uiHarness(undefined, [], preferences);
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(second.elements.advancedTemplates.open, false);
  second.elements.advancedEpisode.value = "12";
  await second.elements.selectAdvancedEpisode.fire("click");
  assert.equal(second.elements.advancedTemplates.open, false);
  assert.equal(preferences.get("popupTemplatesOpen:v1"), false);
  const third = uiHarness(undefined, [], preferences);
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(third.elements.advancedTemplates.open, false);
});
