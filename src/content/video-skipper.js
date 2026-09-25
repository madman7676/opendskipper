(function initializeVideoSkipper() {
  "use strict";

  const {
    DEFAULT_PROFILE,
    MESSAGE,
    RangeExecutor,
    Time
  } = globalThis.OpenDSkipper;

  const runtimeSettings = { timingOffset: { enabled: false, seconds: 0 } };
  const EASY_OPENING_ID = "easy-opening";
  const EASY_ENDING_ID = "easy-ending";

  let currentTopUrl = null;
  let currentProfileKey = null;
  let profile = { ...DEFAULT_PROFILE };
  const attachedVideos = new WeakSet();
  const videoStates = new WeakMap();

  function resetVideoState(video) {
    const state = videoStates.get(video);
    if (!state) {
      return;
    }

    state.source = video.currentSrc || video.src || "";
    state.handledRanges.clear();
    state.playbackEnded = false;
  }

  function resetAllVideoStates() {
    document.querySelectorAll("video").forEach(resetVideoState);
  }

  function handlePlayingVideos() {
    document.querySelectorAll("video").forEach((video) => {
      if (!video.paused && !video.ended) {
        handlePlayback(video);
      }
    });
  }

  function applyProfile(nextTopUrl, nextProfileKey, nextProfile) {
    const startSeconds = Number(nextProfile && nextProfile.skipStart);
    const endSeconds = Number(nextProfile && nextProfile.skipEnd);
    const cleanProfile = {
      enabled: nextProfile && nextProfile.enabled === true,
      skipStart: Time.isFiniteMediaTime(startSeconds) ? Math.max(0, startSeconds) : 0,
      skipEnd: Time.isFiniteMediaTime(endSeconds) ? Math.max(0, endSeconds) : 0
    };
    const shouldResetVideos =
      currentProfileKey !== nextProfileKey ||
      cleanProfile.enabled !== profile.enabled ||
      cleanProfile.skipStart !== profile.skipStart ||
      cleanProfile.skipEnd !== profile.skipEnd;

    currentTopUrl = nextTopUrl;
    currentProfileKey = nextProfileKey;
    profile = cleanProfile;

    if (shouldResetVideos) {
      resetAllVideoStates();
      handlePlayingVideos();
    }
  }

  async function requestProfile() {
    try {
      const response = await chrome.runtime.sendMessage({
        type: MESSAGE.GET_PROFILE
      });

      if (!response || !response.ok) {
        throw new Error(response && response.error);
      }

      if (
        response.data.topUrl !== currentTopUrl ||
        response.data.profileKey !== currentProfileKey ||
        JSON.stringify(response.data.profile) !== JSON.stringify(profile)
      ) {
        applyProfile(
          response.data.topUrl,
          response.data.profileKey,
          response.data.profile
        );
      }
    } catch (error) {
      console.warn("OpEndSkipper: не вдалося отримати профіль сторінки.", error);
      applyProfile(null, null, DEFAULT_PROFILE);
    }
  }

  function handlePlayback(video) {
    const state = videoStates.get(video);
    if (!state) {
      return;
    }

    const source = video.currentSrc || video.src || "";
    if (source !== state.source) {
      resetVideoState(video);
    }

    state.lastActivity = Date.now();

    const currentTime = Time.readCurrentTime(video);
    if (!profile.enabled || currentTime === null) {
      return;
    }

    const duration = Time.readDuration(video);

    if (!state.handledRanges.has(EASY_OPENING_ID) && profile.skipStart > 0) {
      if (currentTime >= profile.skipStart) {
        state.handledRanges.add(EASY_OPENING_ID);
      } else if (video.readyState > 0) {
        RangeExecutor.executeRange(video, {
          id: EASY_OPENING_ID,
          start: 0,
          end: profile.skipStart
        }, state.handledRanges, runtimeSettings);
        return;
      }
    }

    if (
      !state.handledRanges.has(EASY_ENDING_ID) &&
      profile.skipEnd > 0 &&
      !video.paused &&
      duration !== null &&
      duration > 0
    ) {
      const remaining = duration - currentTime;
      if (remaining <= profile.skipEnd) {
        if (remaining <= Time.END_EPSILON_SECONDS) {
          state.handledRanges.add(EASY_ENDING_ID);
        } else {
          RangeExecutor.executeRange(video, {
            id: EASY_ENDING_ID,
            start: Math.max(0, duration - profile.skipEnd),
            end: duration
          }, state.handledRanges, runtimeSettings);
        }
      }
    }
  }

  function attachVideo(video) {
    if (attachedVideos.has(video)) {
      return;
    }

    attachedVideos.add(video);
    videoStates.set(video, {
      source: video.currentSrc || video.src || "",
      handledRanges: new Set(),
      playbackEnded: false,
      lastActivity: 0
    });

    video.addEventListener("timeupdate", () => handlePlayback(video));
    video.addEventListener("playing", () => {
      const state = videoStates.get(video);
      if (state && state.playbackEnded && Time.readCurrentTime(video) < 0.5) {
        resetVideoState(video);
      }
      handlePlayback(video);
    });
    video.addEventListener("loadedmetadata", () => resetVideoState(video));
    video.addEventListener("emptied", () => resetVideoState(video));
    video.addEventListener("ended", () => {
      const state = videoStates.get(video);
      if (state) {
        state.playbackEnded = true;
      }
    });

    if (!video.paused && !video.ended) {
      handlePlayback(video);
    }
  }

  function scanNode(node) {
    if (!(node instanceof Element)) {
      return;
    }

    if (node.matches("video")) {
      attachVideo(node);
    }
    node.querySelectorAll("video").forEach(attachVideo);
  }

  function bestVideoState() {
    const candidates = Array.from(document.querySelectorAll("video"))
      .filter((video) => Time.readCurrentTime(video) !== null)
      .map((video) => {
        const state = videoStates.get(video);
        const rect = video.getBoundingClientRect();
        return {
          currentTime: Time.readCurrentTime(video),
          duration: Time.readDuration(video),
          isPlaying: !video.paused && !video.ended,
          lastActivity: state ? state.lastActivity : 0,
          area: Math.max(0, rect.width) * Math.max(0, rect.height)
        };
      });

    candidates.sort((left, right) =>
      Number(right.isPlaying) - Number(left.isPlaying) ||
      right.lastActivity - left.lastActivity ||
      right.area - left.area
    );

    return candidates[0] || null;
  }

  chrome.runtime.onMessage.addListener((message) => {
    if (message && message.type === MESSAGE.PROFILE_UPDATED) {
      applyProfile(message.topUrl, message.profileKey, message.profile);
      return;
    }

    if (message && message.type === MESSAGE.REQUEST_VIDEO_STATE) {
      const video = bestVideoState();
      if (video) {
        chrome.runtime.sendMessage({
          type: MESSAGE.REPORT_VIDEO_STATE,
          requestId: message.requestId,
          video
        }).catch(() => {
          // Popup міг закритися до завершення збору стану.
        });
      }
    }
  });

  document.querySelectorAll("video").forEach(attachVideo);

  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      mutation.addedNodes.forEach(scanNode);
    }
  });
  observer.observe(document.documentElement, {
    childList: true,
    subtree: true
  });

  requestProfile();

  window.addEventListener("pageshow", requestProfile);
  window.addEventListener("popstate", requestProfile);
  window.addEventListener("hashchange", requestProfile);
})();
