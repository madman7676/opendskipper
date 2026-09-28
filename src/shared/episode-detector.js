(function initializeEpisodeDetector(root) {
  "use strict";

  const { StringTransforms } = root.OpenDSkipper;
  const SOURCES = Object.freeze([
    "frame-url", "iframe-src", "video-current-src", "video-src", "source-src"
  ]);
  const TRANSFORMS = new Set(Object.values(StringTransforms.TYPE));

  function normalizeId(value) {
    if (typeof value !== "string") return null;
    return value.trim().replace(/\s+/g, " ") || null;
  }

  function normalizeConfig(value) {
    if (!value || (value.type !== "top-url" && value.type !== "player-url")) return null;
    if (!Array.isArray(value.transforms) || value.transforms.length > 20) return null;
    const transforms = [];
    for (const step of value.transforms) {
      if (!step || !TRANSFORMS.has(step.type) || typeof step.value !== "string" ||
          !step.value || step.value.length > 2048) return null;
      const normalized = { type: step.type, value: step.value };
      if (step.type === "removeExact" || step.type === "replaceExact") {
        const position = step.position || "anywhere";
        if (!Object.values(StringTransforms.POSITION).includes(position)) return null;
        normalized.position = position;
      }
      if (step.type === "replaceExact") {
        if (typeof step.replacement !== "string" || step.replacement.length > 2048) return null;
        normalized.replacement = step.replacement;
      }
      transforms.push(normalized);
    }
    if (value.type === "top-url") return { type: "top-url", transforms };
    if (!SOURCES.includes(value.source)) return null;
    return { type: "player-url", source: value.source, transforms };
  }

  function detectEpisode(config, context) {
    const safe = normalizeConfig(config);
    if (!safe) return null;
    let raw;
    if (safe.type === "top-url") raw = context && context.topUrl;
    else raw = context && Array.isArray(context.candidates) &&
      context.candidates.find((candidate) => candidate.source === safe.source)?.value;
    if (typeof raw !== "string" || !raw) return null;
    const id = normalizeId(StringTransforms.applyAll(raw, safe.transforms));
    return id ? { id, sourceType: safe.type, source: safe.type === "player-url" ? safe.source : "top-url" } : null;
  }

  function collectCandidates({ frameUrl, iframes = [], videos = [] }) {
    const candidates = [];
    const add = (source, value) => {
      if (typeof value === "string" && value.length > 0) candidates.push({ source, value });
    };
    if (videos.length) add("frame-url", frameUrl);
    for (const frame of iframes) add("iframe-src", frame.src);
    for (const video of videos) {
      add("video-current-src", video.currentSrc);
      add("video-src", video.src);
      for (const source of video.sources || []) add("source-src", source.src);
    }
    return candidates;
  }

  function transition(previousId, detected, contextChanged = false) {
    const id = contextChanged ? null : previousId;
    if (!detected) return { id, changed: contextChanged && previousId !== null };
    return { id: detected.id, changed: id !== detected.id };
  }

  root.OpenDSkipper.EpisodeDetector = Object.freeze({
    SOURCES, normalizeId, normalizeConfig, detectEpisode, collectCandidates, transition
  });
})(globalThis);
