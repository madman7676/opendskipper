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
    COLLECT_VIDEO_STATE: "video:collect-state",
    REQUEST_VIDEO_STATE: "video:request-state",
    REPORT_VIDEO_STATE: "video:report-state"
  });

  namespace.PROFILE_KEY_PREFIX = "profile:v1:";
  namespace.COPIED_SKIP_SETTINGS_KEY = "copiedSkipSettings";
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
