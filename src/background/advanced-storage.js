(function initializeAdvancedStorage(root) {
  "use strict";

  const {
    ADVANCED_PROFILE_PREFIX,
    ADVANCED_TIMING_POOL_KEY,
    COPIED_SKIP_SETTINGS_KEY,
    EpisodeDetector,
    PROFILE_KEY_PREFIX,
    Advanced,
    Profiles
  } = root.OpenDSkipper;

  let writeQueue = Promise.resolve();

  function serializeWrite(action) {
    const result = writeQueue.then(action);
    writeQueue = result.catch(() => {});
    return result;
  }

  function normalizeEpisodeId(value) {
    const id = EpisodeDetector.normalizeId(value);
    if (!id) throw new Error("Episode ID не визначено.");
    return id;
  }

  async function storageKey(profileKey) {
    const easyKey = await Profiles.profileStorageKey(profileKey);
    return `${ADVANCED_PROFILE_PREFIX}${easyKey.slice(PROFILE_KEY_PREFIX.length)}`;
  }

  function cleanProfile(value, profileKey) {
    if (!value || value.profileKey !== profileKey) {
      return { profileKey, mode: "easy", episodeDetector: null, episodes: {} };
    }
    return {
      profileKey,
      mode: value.mode === "advanced" ? "advanced" : "easy",
      episodeDetector: EpisodeDetector.normalizeConfig(value.episodeDetector),
      episodes: value.episodes && typeof value.episodes === "object" ? value.episodes : {}
    };
  }

  async function read(profileKey) {
    const key = await storageKey(profileKey);
    const stored = await chrome.storage.local.get([key, ADVANCED_TIMING_POOL_KEY]);
    const pool = stored[ADVANCED_TIMING_POOL_KEY];
    const profile = cleanProfile(stored[key], profileKey);
    if (stored[key] && Object.hasOwn(stored[key], "currentEpisode")) {
      await chrome.storage.local.set({ [key]: profile });
    }
    return {
      key,
      profile,
      timings: pool && pool.timings && typeof pool.timings === "object" ? pool.timings : {}
    };
  }

  async function loadContext(profileKey, episodeId = null) {
    const { profile, timings } = await read(profileKey);
    const ranges = episodeId ? Advanced.resolveEpisode(profile, timings, episodeId) : [];
    return {
      mode: profile.mode,
      episodeDetector: profile.episodeDetector,
      currentEpisode: episodeId,
      timingKeys: ranges.map((range) => range.key),
      ranges
    };
  }

  function setMode(profileKey, mode) {
    if (mode !== "easy" && mode !== "advanced") {
      throw new Error("Невідомий режим.");
    }
    return serializeWrite(async () => {
      const { key, profile } = await read(profileKey);
      await chrome.storage.local.set({ [key]: { ...profile, mode } });
    });
  }

  function setDetector(profileKey, detector) {
    const episodeDetector = EpisodeDetector.normalizeConfig(detector);
    if (detector !== null && !episodeDetector) throw new Error("Некоректне налаштування Episode detector.");
    return serializeWrite(async () => {
      const { key, profile } = await read(profileKey);
      await chrome.storage.local.set({ [key]: { ...profile, episodeDetector } });
    });
  }

  function saveRanges(profileKey, episodeId, draftRanges) {
    const id = normalizeEpisodeId(episodeId);
    if (!Array.isArray(draftRanges)) {
      throw new Error("Некоректний набір діапазонів.");
    }
    return serializeWrite(async () => {
      const { key, profile, timings } = await read(profileKey);
      const resolved = [];
      const seen = new Set();
      for (const item of draftRanges) {
        const timing = item && typeof item.key === "string"
          ? Advanced.getTiming(timings, item.key)
          : item && Advanced.getOrCreateTiming(timings, item.start, item.end);
        if (!timing) {
          throw new Error("Діапазон має містити коректні start та end, end > start.");
        }
        if (!seen.has(timing.key)) {
          seen.add(timing.key);
          resolved.push(timing);
        }
      }
      const episode = { ranges: Advanced.sortRanges(resolved).map((timing) => timing.key) };
      const episodes = { ...profile.episodes, [id]: episode };
      await chrome.storage.local.set({
        [ADVANCED_TIMING_POOL_KEY]: { timings },
        [key]: { ...profile, episodes }
      });
    });
  }

  async function copyRanges(profileKey, episodeId) {
    const { profile, timings } = await read(profileKey);
    const ranges = Advanced.resolveEpisode(profile, timings, normalizeEpisodeId(episodeId));
    const keys = ranges.map((range) => range.key);
    await chrome.storage.local.set({
      [COPIED_SKIP_SETTINGS_KEY]: { type: "advanced-range-set", timingKeys: keys }
    });
    return keys;
  }

  async function getClipboard() {
    const stored = await chrome.storage.local.get([COPIED_SKIP_SETTINGS_KEY, ADVANCED_TIMING_POOL_KEY]);
    const clipboard = stored[COPIED_SKIP_SETTINGS_KEY];
    if (!clipboard || clipboard.type !== "advanced-range-set" ||
        !Array.isArray(clipboard.timingKeys)) {
      throw new Error("Буфер порожній або містить Easy налаштування.");
    }
    const pool = stored[ADVANCED_TIMING_POOL_KEY];
    const timings = pool && pool.timings || {};
    const ranges = [];
    const seen = new Set();
    for (const key of clipboard.timingKeys) {
      const timing = Advanced.getTiming(timings, key);
      if (!timing) {
        throw new Error("Скопійований діапазон більше недоступний.");
      }
      if (!seen.has(key)) {
        ranges.push(timing);
        seen.add(key);
      }
    }
    return Advanced.sortRanges(ranges);
  }

  root.OpenDSkipper.AdvancedStorage = Object.freeze({
    storageKey,
    loadContext,
    setMode,
    setDetector,
    saveRanges,
    copyRanges,
    getClipboard
  });
})(globalThis);
