(function initializeConstants(root) {
  "use strict";

  const namespace = root.OpenDSkipper || {};

  namespace.DEFAULT_PROFILE = Object.freeze({
    enabled: false,
    skipStart: 0,
    skipEnd: 0
  });

  namespace.MESSAGE = Object.freeze({
    GET_PROFILE: "profile:get-for-sender",
    GET_POPUP_CONTEXT: "profile:get-popup-context",
    SAVE_PROFILE: "profile:save-for-tab",
    PROFILE_UPDATED: "profile:updated",
    GET_COPIED_SKIP_SETTINGS: "skip-buffer:get",
    COPY_SKIP_SETTINGS: "skip-buffer:copy",
    PASTE_SKIP_SETTINGS: "skip-buffer:paste-for-tab",
    SAVE_URL_FIXER_SETTINGS: "url-fixers:save-for-tab",
    COLLECT_VIDEO_STATE: "video:collect-state",
    REQUEST_VIDEO_STATE: "video:request-state",
    REPORT_VIDEO_STATE: "video:report-state",
    SET_ADVANCED_MODE: "advanced:set-mode",
    SET_ADVANCED_EPISODE: "advanced:set-episode",
    SAVE_ADVANCED_RANGES: "advanced:save-ranges",
    COPY_ADVANCED_RANGES: "advanced:copy-ranges",
    GET_ADVANCED_CLIPBOARD: "advanced:get-clipboard"
  });

  namespace.PROFILE_KEY_PREFIX = "profile:v1:";
  namespace.ADVANCED_PROFILE_PREFIX = "advancedProfile:v1:";
  namespace.ADVANCED_TIMING_POOL_KEY = "advancedTimingPool:v1";
  namespace.COPIED_SKIP_SETTINGS_KEY = "copiedSkipSettings";
  namespace.URL_FIXER_SETTINGS_KEY = "urlFixerSettings";
  namespace.URL_FIXER_SCHEMA_VERSION = 1;
  namespace.LEGACY_STORAGE_KEYS = Object.freeze([
    "skipStartSeconds",
    "skipEndSeconds",
    "enabled",
    "blacklist",
    "selectedElement",
    "opSkip",
    "endSkip"
  ]);

  root.OpenDSkipper = namespace;
})(globalThis);
