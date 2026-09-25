(function initializeTime(root) {
  "use strict";

  const END_EPSILON_SECONDS = 0.05;

  function isFiniteMediaTime(value) {
    return typeof value === "number" && Number.isFinite(value);
  }

  function readCurrentTime(video) {
    return video && isFiniteMediaTime(video.currentTime) ? video.currentTime : null;
  }

  function readDuration(video) {
    return video && isFiniteMediaTime(video.duration) ? video.duration : null;
  }

  function clampMediaTime(value, duration) {
    if (!isFiniteMediaTime(value)) {
      return null;
    }
    return Math.min(Math.max(0, value), isFiniteMediaTime(duration) ? Math.max(0, duration) : Infinity);
  }

  function formatTimeInput(seconds) {
    if (!isFiniteMediaTime(seconds) || seconds < 0) {
      return "";
    }
    const wholeSeconds = Math.floor(seconds);
    const hours = Math.floor(wholeSeconds / 3600);
    if (hours > 23) {
      return ""; // Native time inputs represent a clock time within one day.
    }
    const minutes = Math.floor((wholeSeconds % 3600) / 60);
    const remainder = wholeSeconds % 60;
    return [hours, minutes, remainder].map((part) => String(part).padStart(2, "0")).join(":");
  }

  function parseTimeInput(value) {
    if (typeof value !== "string") {
      return null;
    }
    const match = /^(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(value);
    if (!match) {
      return null;
    }
    const hours = Number(match[1]);
    const minutes = Number(match[2]);
    const seconds = Number(match[3] || 0);
    return hours < 24 && minutes < 60 && seconds < 60
      ? hours * 3600 + minutes * 60 + seconds
      : null;
  }

  function getFractionalSeconds(seconds) {
    return isFiniteMediaTime(seconds) && seconds >= 0
      ? seconds - Math.floor(seconds)
      : 0;
  }

  // runtimeSettings.timingOffset: { enabled: boolean, seconds: number }.
  // Profile targets remain unchanged; only the executed seek is shifted.
  function seekTo(video, targetSeconds, runtimeSettings = {}) {
    if (!video || !isFiniteMediaTime(targetSeconds)) {
      return false;
    }

    const offset = runtimeSettings.timingOffset;
    const offsetSeconds = offset && offset.enabled === true && isFiniteMediaTime(offset.seconds)
      ? offset.seconds
      : 0;
    const duration = readDuration(video);
    const effectiveTarget = clampMediaTime(targetSeconds + offsetSeconds, duration);
    if (effectiveTarget === null) {
      return false;
    }

    const endBoundary = duration !== null
      ? Math.max(0, duration - END_EPSILON_SECONDS)
      : null;
    const destination = endBoundary !== null && effectiveTarget >= endBoundary
      ? endBoundary
      : effectiveTarget;
    const currentTime = readCurrentTime(video);
    if (currentTime !== null && currentTime >= destination) {
      return false;
    }

    video.currentTime = destination;
    return true;
  }

  root.OpenDSkipper.Time = Object.freeze({
    END_EPSILON_SECONDS,
    isFiniteMediaTime,
    readCurrentTime,
    readDuration,
    clampMediaTime,
    formatTimeInput,
    parseTimeInput,
    getFractionalSeconds,
    seekTo
  });
})(globalThis);
