(function initializeAdvancedStorage(root) {
  "use strict";

  const {
    ADVANCED_PROFILE_PREFIX,
    ADVANCED_TIMING_POOL_KEY,
    COPIED_SKIP_SETTINGS_KEY,
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
    const id = typeof value === "string" ? value.trim() : "";
    if (!id || id.length > 80 || /[\x00-\x1f\x7f]/.test(id) ||
        ["__proto__", "constructor", "prototype"].includes(id)) {
      throw new Error("Введіть коректний ідентифікатор серії (до 80 символів).");
    }
    return id;
  }

  async function storageKey(profileKey) {
    const easyKey = await Profiles.profileStorageKey(profileKey);
    return `${ADVANCED_PROFILE_PREFIX}${easyKey.slice(PROFILE_KEY_PREFIX.length)}`;
  }

  function cleanProfile(value, profileKey) {
    if (!value || value.profileKey !== profileKey) {
      return { profileKey, mode: "easy", currentEpisode: "1", episodes: {} };
    }
    return {
      profileKey,
      mode: value.mode === "advanced" ? "advanced" : "easy",
      currentEpisode: (() => {
        try { return normalizeEpisodeId(value.currentEpisode); } catch { return "1"; }
      })(),
      episodes: value.episodes && typeof value.episodes === "object" ? value.episodes : {}
    };
  }

  async function read(profileKey) {
    const key = await storageKey(profileKey);
    const stored = await chrome.storage.local.get([key, ADVANCED_TIMING_POOL_KEY]);
    const pool = stored[ADVANCED_TIMING_POOL_KEY];
    return {
      key,
      profile: cleanProfile(stored[key], profileKey),
      timings: pool && pool.timings && typeof pool.timings === "object" ? pool.timings : {}
    };
  }

  async function loadContext(profileKey) {
    const { profile, timings } = await read(profileKey);
    const ranges = Advanced.resolveEpisode(profile, timings);
    return {
      mode: profile.mode,
      currentEpisode: profile.currentEpisode,
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

  function setEpisode(profileKey, episodeId) {
    const currentEpisode = normalizeEpisodeId(episodeId);
    return serializeWrite(async () => {
      const { key, profile } = await read(profileKey);
      await chrome.storage.local.set({ [key]: { ...profile, currentEpisode } });
    });
  }

  function saveRanges(profileKey, episodeId, draftRanges) {
    const id = normalizeEpisodeId(episodeId);
    if (!Array.isArray(draftRanges)) {
      throw new Error("Некоректний набір діапазонів.");
    }
    return serializeWrite(async () => {
      const { key, profile, timings } = await read(profileKey);
      if (profile.currentEpisode !== id) {
        throw new Error("Поточна серія змінилася. Оновіть popup.");
      }
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

  async function copyRanges(profileKey, selectedKey = null) {
    const { profile, timings } = await read(profileKey);
    const ranges = Advanced.resolveEpisode(profile, timings);
    const keys = selectedKey === null
      ? ranges.map((range) => range.key)
      : ranges.some((range) => range.key === selectedKey) ? [selectedKey] : null;
    if (!keys) {
      throw new Error("Спочатку збережіть діапазон цієї серії.");
    }
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
    setEpisode,
    saveRanges,
    copyRanges,
    getClipboard
  });
})(globalThis);
