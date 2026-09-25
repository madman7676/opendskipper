(function initializeAdvanced(root) {
  "use strict";

  const { Time } = root.OpenDSkipper;

  function normalizeTiming(start, end) {
    if (!Time.isFiniteMediaTime(start) || !Time.isFiniteMediaTime(end) || start < 0) {
      return null;
    }
    const startKey = Math.round(start * 100);
    const endKey = Math.round(end * 100);
    if (!Number.isSafeInteger(startKey) || !Number.isSafeInteger(endKey) ||
        startKey < 0 || endKey <= startKey) {
      return null;
    }
    return {
      key: `${startKey}:${endKey}`,
      start: startKey / 100,
      end: endKey / 100
    };
  }

  function makeTimingKey(start, end) {
    const timing = normalizeTiming(start, end);
    return timing ? timing.key : null;
  }

  function getTiming(timings, key) {
    if (!timings || !Object.hasOwn(timings, key)) {
      return null;
    }
    const timing = timings[key];
    const normalized = timing && normalizeTiming(timing.start, timing.end);
    return normalized && normalized.key === key
      ? { key, start: normalized.start, end: normalized.end }
      : null;
  }

  function getOrCreateTiming(timings, start, end) {
    const normalized = normalizeTiming(start, end);
    if (!normalized) {
      return null;
    }
    const existing = getTiming(timings, normalized.key);
    if (existing) {
      return existing;
    }
    if (Object.hasOwn(timings, normalized.key)) {
      return null; // Never overwrite an existing timing record.
    }
    timings[normalized.key] = { start: normalized.start, end: normalized.end };
    return normalized;
  }

  function sortRanges(ranges) {
    return [...ranges].sort((left, right) =>
      left.start - right.start || left.end - right.end ||
      String(left.key || "").localeCompare(String(right.key || ""))
    );
  }

  function resolveEpisode(profile, timings, episodeId = profile.currentEpisode) {
    const episode = profile.episodes && profile.episodes[episodeId];
    const keys = episode && Array.isArray(episode.ranges) ? episode.ranges : [];
    const seen = new Set();
    return sortRanges(keys.map((key) => {
      if (typeof key !== "string" || seen.has(key)) {
        return null;
      }
      seen.add(key);
      return getTiming(timings, key);
    }).filter(Boolean));
  }

  root.OpenDSkipper.Advanced = Object.freeze({
    normalizeTiming,
    makeTimingKey,
    getTiming,
    getOrCreateTiming,
    sortRanges,
    resolveEpisode
  });
})(globalThis);
