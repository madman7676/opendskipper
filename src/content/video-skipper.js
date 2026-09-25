(function initializeVideoSkipper() {
  "use strict";

  const {
    DEFAULT_PROFILE,
    MESSAGE
  } = globalThis.OpenDSkipper;

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
    state.startHandled = false;
    state.endHandled = false;
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
    const cleanProfile = {
      enabled: nextProfile && nextProfile.enabled === true,
      skipStart: Math.max(0, Number(nextProfile && nextProfile.skipStart) || 0),
      skipEnd: Math.max(0, Number(nextProfile && nextProfile.skipEnd) || 0)
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

    if (!profile.enabled || !Number.isFinite(video.currentTime)) {
      return;
    }

    const duration = video.duration;

    if (!state.startHandled && profile.skipStart > 0) {
      if (video.currentTime >= profile.skipStart) {
        state.startHandled = true;
      } else if (video.readyState > 0) {
        state.startHandled = true;
        const latestSafeTime = Number.isFinite(duration)
          ? Math.max(0, duration - 0.05)
          : profile.skipStart;
        video.currentTime = Math.min(profile.skipStart, latestSafeTime);
        return;
      }
    }

    if (
      !state.endHandled &&
      profile.skipEnd > 0 &&
      !video.paused &&
      Number.isFinite(duration) &&
      duration > 0
    ) {
      const remaining = duration - video.currentTime;
      if (remaining <= profile.skipEnd) {
        state.endHandled = true;
        if (remaining > 0.05) {
          video.currentTime = Math.max(video.currentTime, duration - 0.05);
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
      startHandled: false,
      endHandled: false,
      playbackEnded: false,
      lastActivity: 0
    });

    video.addEventListener("timeupdate", () => handlePlayback(video));
    video.addEventListener("playing", () => {
      const state = videoStates.get(video);
      if (state && state.playbackEnded && video.currentTime < 0.5) {
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
      .filter((video) => Number.isFinite(video.currentTime))
      .map((video) => {
        const state = videoStates.get(video);
        const rect = video.getBoundingClientRect();
        return {
          currentTime: video.currentTime,
          duration: Number.isFinite(video.duration) ? video.duration : null,
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
