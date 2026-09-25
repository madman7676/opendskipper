(function initializeProfiles(root) {
  "use strict";

  const {
    COPIED_SKIP_SETTINGS_KEY,
    DEFAULT_PROFILE,
    LEGACY_STORAGE_KEYS,
    PROFILE_KEY_PREFIX
  } = root.OpenDSkipper;

  function sanitizeSeconds(value) {
    const number = Number(value);
    return Number.isFinite(number) && number >= 0 ? number : 0;
  }

  function sanitizeProfile(value) {
    const source = value && typeof value === "object" ? value : {};
    return {
      enabled: source.enabled === true,
      skipStart: sanitizeSeconds(source.skipStart),
      skipEnd: sanitizeSeconds(source.skipEnd)
    };
  }

  function sanitizeSkipSettings(value) {
    const source = value && typeof value === "object" ? value : {};
    return {
      skipStart: sanitizeSeconds(source.skipStart),
      skipEnd: sanitizeSeconds(source.skipEnd)
    };
  }

  function validateCopiedSkipSettings(value) {
    if (!value || typeof value !== "object") {
      return null;
    }

    const { skipStart, skipEnd } = value;
    if (
      typeof skipStart !== "number" ||
      !Number.isFinite(skipStart) ||
      skipStart < 0 ||
      typeof skipEnd !== "number" ||
      !Number.isFinite(skipEnd) ||
      skipEnd < 0
    ) {
      return null;
    }

    return { skipStart, skipEnd };
  }

  async function copySkipSettings(settings) {
    const cleanSettings = sanitizeSkipSettings(settings);
    await chrome.storage.local.set({
      [COPIED_SKIP_SETTINGS_KEY]: cleanSettings
    });
    return cleanSettings;
  }

  async function getCopiedSkipSettings() {
    const stored = await chrome.storage.local.get(COPIED_SKIP_SETTINGS_KEY);
    return validateCopiedSkipSettings(stored[COPIED_SKIP_SETTINGS_KEY]);
  }

  async function hasCopiedSkipSettings() {
    return (await getCopiedSkipSettings()) !== null;
  }

  async function profileStorageKey(url) {
    if (typeof url !== "string" || url.length === 0) {
      throw new Error("Не вдалося визначити URL верхньої сторінки.");
    }

    const bytes = new TextEncoder().encode(url);
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    const hash = Array.from(new Uint8Array(digest), (byte) =>
      byte.toString(16).padStart(2, "0")
    ).join("");

    return `${PROFILE_KEY_PREFIX}${hash}`;
  }

  async function loadProfile(url) {
    const key = await profileStorageKey(url);
    const stored = (await chrome.storage.sync.get(key))[key];

    if (!stored || stored.url !== url) {
      return {
        exists: false,
        profile: { ...DEFAULT_PROFILE }
      };
    }

    return {
      exists: true,
      profile: sanitizeProfile(stored.profile)
    };
  }

  async function saveProfile(url, profile) {
    const key = await profileStorageKey(url);
    const cleanProfile = sanitizeProfile(profile);

    await chrome.storage.sync.set({
      [key]: {
        url,
        profile: cleanProfile
      }
    });

    return cleanProfile;
  }

  async function removeLegacySettings() {
    await chrome.storage.sync.remove(LEGACY_STORAGE_KEYS);
  }

  root.OpenDSkipper.Profiles = Object.freeze({
    copySkipSettings,
    getCopiedSkipSettings,
    hasCopiedSkipSettings,
    loadProfile,
    removeLegacySettings,
    sanitizeSkipSettings,
    sanitizeProfile,
    saveProfile
  });
})(globalThis);
