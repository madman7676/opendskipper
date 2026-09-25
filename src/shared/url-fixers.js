(function initializeUrlFixers(root) {
  "use strict";

  const {
    URL_FIXER_SCHEMA_VERSION,
    URL_FIXER_SETTINGS_KEY
  } = root.OpenDSkipper;

  const MAX_RULES = 100;
  const MAX_FIELD_LENGTH = 2048;
  const MAX_ID_LENGTH = 128;
  const MAX_PROFILE_KEY_LENGTH = 32768;

  const OPERATION = Object.freeze({
    TRUNCATE_AFTER: "truncateAfter",
    TRUNCATE_AFTER_LAST: "truncateAfterLast",
    REMOVE_EXACT: "removeExact",
    REPLACE_EXACT: "replaceExact"
  });

  const POSITION = Object.freeze({
    START: "start",
    END: "end",
    ANYWHERE: "anywhere"
  });

  const VALID_OPERATIONS = new Set(Object.values(OPERATION));
  const VALID_POSITIONS = new Set(Object.values(POSITION));

  const DEFAULT_RULE = Object.freeze({
    id: "rule-default-truncate-fragment-v1",
    enabled: true,
    operation: OPERATION.TRUNCATE_AFTER,
    value: "#"
  });

  function isValidId(value) {
    return typeof value === "string" && value.length > 0 && value.length <= MAX_ID_LENGTH;
  }

  function isValidSearchValue(value) {
    return typeof value === "string" && value.length > 0 && value.length <= MAX_FIELD_LENGTH;
  }

  function isValidReplacement(value) {
    return typeof value === "string" && value.length <= MAX_FIELD_LENGTH;
  }

  function normalizeRule(rule) {
    if (
      !rule ||
      typeof rule !== "object" ||
      !isValidId(rule.id) ||
      !VALID_OPERATIONS.has(rule.operation) ||
      !isValidSearchValue(rule.value)
    ) {
      return null;
    }

    const normalized = {
      id: rule.id,
      enabled: rule.enabled === true,
      operation: rule.operation,
      value: rule.value
    };

    if (
      rule.operation === OPERATION.TRUNCATE_AFTER ||
      rule.operation === OPERATION.TRUNCATE_AFTER_LAST
    ) {
      return normalized;
    }

    if (!VALID_POSITIONS.has(rule.position)) {
      return null;
    }
    normalized.position = rule.position;

    if (rule.operation === OPERATION.REPLACE_EXACT) {
      if (!isValidReplacement(rule.replacement)) {
        return null;
      }
      normalized.replacement = rule.replacement;
    }

    return normalized;
  }

  function normalizeRules(rules) {
    if (!Array.isArray(rules)) {
      return [];
    }

    const normalized = [];
    const ids = new Set();

    for (const candidate of rules.slice(0, MAX_RULES)) {
      const rule = normalizeRule(candidate);
      if (!rule || ids.has(rule.id)) {
        continue;
      }
      ids.add(rule.id);
      normalized.push(rule);
    }

    return normalized;
  }

  function createRule(values) {
    const candidate = {
      ...values,
      id: `rule-${crypto.randomUUID()}`,
      enabled: true
    };
    return normalizeRule(candidate);
  }

  function applyUrlFixer(currentUrl, rule) {
    if (rule.operation === OPERATION.TRUNCATE_AFTER) {
      const index = currentUrl.indexOf(rule.value);
      return index === -1 ? currentUrl : currentUrl.slice(0, index);
    }

    if (rule.operation === OPERATION.TRUNCATE_AFTER_LAST) {
      const index = currentUrl.lastIndexOf(rule.value);
      return index === -1 ? currentUrl : currentUrl.slice(0, index);
    }

    if (rule.position === POSITION.START) {
      if (!currentUrl.startsWith(rule.value)) {
        return currentUrl;
      }
      const replacement = rule.operation === OPERATION.REPLACE_EXACT
        ? rule.replacement
        : "";
      return replacement + currentUrl.slice(rule.value.length);
    }

    if (rule.position === POSITION.END) {
      if (!currentUrl.endsWith(rule.value)) {
        return currentUrl;
      }
      const replacement = rule.operation === OPERATION.REPLACE_EXACT
        ? rule.replacement
        : "";
      return currentUrl.slice(0, currentUrl.length - rule.value.length) + replacement;
    }

    if (rule.position === POSITION.ANYWHERE) {
      const replacement = rule.operation === OPERATION.REPLACE_EXACT
        ? rule.replacement
        : "";
      return currentUrl.split(rule.value).join(replacement);
    }

    return currentUrl;
  }

  function isValidProfileKey(value) {
    if (
      typeof value !== "string" ||
      value.length === 0 ||
      value.length > MAX_PROFILE_KEY_LENGTH
    ) {
      return false;
    }

    try {
      const parsed = new URL(value);
      return parsed.protocol.length > 1;
    } catch {
      return false;
    }
  }

  function applyUrlFixers(originalUrl, rules) {
    if (!isValidProfileKey(originalUrl)) {
      return {
        profileKey: originalUrl,
        changed: false,
        warning: "Початковий URL не можна використати як ключ профілю."
      };
    }

    let currentUrl = originalUrl;
    for (const rule of normalizeRules(rules)) {
      if (rule.enabled) {
        currentUrl = applyUrlFixer(currentUrl, rule);
      }
    }

    if (!isValidProfileKey(currentUrl)) {
      return {
        profileKey: originalUrl,
        changed: false,
        warning: "Результат правил некоректний — використовується початковий URL."
      };
    }

    return {
      profileKey: currentUrl,
      changed: currentUrl !== originalUrl,
      warning: null
    };
  }

  function normalizeSettings(value) {
    return {
      schemaVersion: URL_FIXER_SCHEMA_VERSION,
      rules: normalizeRules(value && value.rules)
    };
  }

  function isInitialized(value) {
    return Boolean(
      value &&
      typeof value === "object" &&
      Number.isInteger(value.schemaVersion) &&
      value.schemaVersion >= URL_FIXER_SCHEMA_VERSION
    );
  }

  async function loadUrlFixerSettings() {
    const stored = await chrome.storage.sync.get(URL_FIXER_SETTINGS_KEY);
    const value = stored[URL_FIXER_SETTINGS_KEY];

    if (isInitialized(value)) {
      return normalizeSettings(value);
    }

    const settings = {
      schemaVersion: URL_FIXER_SCHEMA_VERSION,
      rules: [{ ...DEFAULT_RULE }]
    };
    await chrome.storage.sync.set({ [URL_FIXER_SETTINGS_KEY]: settings });
    return settings;
  }

  async function saveUrlFixerRules(rules) {
    const settings = {
      schemaVersion: URL_FIXER_SCHEMA_VERSION,
      rules: normalizeRules(rules)
    };
    await chrome.storage.sync.set({ [URL_FIXER_SETTINGS_KEY]: settings });
    return settings;
  }

  async function resolveProfileKey(originalUrl) {
    const settings = await loadUrlFixerSettings();
    return {
      ...applyUrlFixers(originalUrl, settings.rules),
      settings
    };
  }

  root.OpenDSkipper.UrlFixers = Object.freeze({
    DEFAULT_RULE,
    MAX_FIELD_LENGTH,
    MAX_RULES,
    OPERATION,
    POSITION,
    applyUrlFixers,
    createRule,
    loadUrlFixerSettings,
    normalizeRule,
    normalizeRules,
    resolveProfileKey,
    saveUrlFixerRules
  });
})(globalThis);
