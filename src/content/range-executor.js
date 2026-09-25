(function initializeRangeExecutor(root) {
  "use strict";

  const { Time } = root.OpenDSkipper;

  function executeRange(video, range, handledRanges, runtimeSettings) {
    if (!range || typeof range.id !== "string" || range.id.length === 0 ||
        !Time.isFiniteMediaTime(range.start) || range.start < 0 ||
        !Time.isFiniteMediaTime(range.end) || range.end <= range.start ||
        !handledRanges || typeof handledRanges.has !== "function" ||
        typeof handledRanges.add !== "function" || handledRanges.has(range.id)) {
      return false;
    }

    const currentTime = Time.readCurrentTime(video);
    if (currentTime === null || currentTime < range.start || currentTime >= range.end) {
      return false;
    }

    if (!Time.seekTo(video, range.end, runtimeSettings)) {
      return false;
    }

    handledRanges.add(range.id);
    return true;
  }

  root.OpenDSkipper.RangeExecutor = Object.freeze({ executeRange });
})(globalThis);
