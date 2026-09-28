importScripts(
  "../shared/constants.js",
  "../shared/string-transforms.js",
  "../shared/episode-detector.js",
  "../shared/time.js",
  "../shared/advanced.js",
  "../shared/url-fixers.js",
  "../shared/profiles.js",
  "advanced-storage.js"
);

const {
  ADVANCED_PROFILE_PREFIX,
  AdvancedStorage,
  EpisodeDetector,
  MESSAGE,
  PROFILE_KEY_PREFIX,
  Profiles,
  URL_FIXER_SETTINGS_KEY,
  UrlFixers
} = globalThis.OpenDSkipper;

const videoStateCollections = new Map();
const episodeSourcesByTab = new Map();
const episodeSourceCollections = new Map();
const episodeSourceRefreshes = new Map();
const runtimeEpisodes = new Map();

function rememberEpisodeSources(tabId, frameId, candidates) {
  if (!episodeSourcesByTab.has(tabId)) episodeSourcesByTab.set(tabId, new Map());
  episodeSourcesByTab.get(tabId).set(frameId, Array.isArray(candidates) ? candidates : []);
}

function episodeCandidates(tabId) {
  const candidates = Array.from(episodeSourcesByTab.get(tabId)?.entries() || [])
    .flatMap(([frameId, candidates]) => candidates.map((candidate) => ({ ...candidate, frameId })))
    .filter((candidate) => EpisodeDetector.SOURCES.includes(candidate.source) &&
      typeof candidate.value === "string" && candidate.value.length > 0)
    .sort((left, right) => Number(right.isPlaying) - Number(left.isPlaying) ||
      left.frameId - right.frameId);
  return candidates.some((candidate) => candidate.source === "frame-url") ? candidates : [];
}

async function collectEpisodeSources(tabId) {
  if (episodeSourceRefreshes.has(tabId)) return episodeSourceRefreshes.get(tabId);
  const requestId = crypto.randomUUID();
  episodeSourcesByTab.set(tabId, new Map());
  const refresh = new Promise((resolve) => {
    episodeSourceCollections.set(requestId, { tabId, resolve });
    chrome.tabs.sendMessage(tabId, { type: MESSAGE.REQUEST_EPISODE_SOURCES, requestId })
      .catch(() => {});
    setTimeout(() => {
      episodeSourceCollections.delete(requestId);
      resolve(episodeCandidates(tabId));
    }, 250);
  });
  episodeSourceRefreshes.set(tabId, refresh);
  refresh.finally(() => episodeSourceRefreshes.delete(tabId));
  return refresh;
}

async function getTabContext(tabId, includeFixerSettings = false) {
  if (!Number.isInteger(tabId)) {
    throw new Error("Некоректний ідентифікатор вкладки.");
  }

  const topFrame = await chrome.webNavigation.getFrame({
    tabId,
    frameId: 0
  });
  if (!topFrame || !topFrame.url) {
    throw new Error("Не вдалося визначити URL активної вкладки.");
  }

  const resolution = await UrlFixers.resolveProfileKey(topFrame.url);
  const loaded = await Profiles.loadProfile(resolution.profileKey);
  const detectorSettings = await AdvancedStorage.loadContext(resolution.profileKey);
  const latestTopFrame = await chrome.webNavigation.getFrame({ tabId, frameId: 0 });
  if (latestTopFrame?.url !== topFrame.url) {
    return getTabContext(tabId, includeFixerSettings);
  }
  const previous = runtimeEpisodes.get(tabId);
  const detectorSignature = JSON.stringify(detectorSettings.episodeDetector);
  const contextChanged = !detectorSettings.episodeDetector || Boolean(previous &&
    (previous.profileKey !== resolution.profileKey ||
      previous.detectorSignature !== detectorSignature));
  const detected = EpisodeDetector.detectEpisode(detectorSettings.episodeDetector, {
    topUrl: topFrame.url,
    candidates: episodeCandidates(tabId)
  });
  const transition = EpisodeDetector.transition(previous?.id || null, detected, contextChanged);
  runtimeEpisodes.set(tabId, {
    profileKey: resolution.profileKey, detectorSignature, id: transition.id
  });
  const advanced = await AdvancedStorage.loadContext(resolution.profileKey, transition.id);
  const context = {
    tabId,
    topUrl: topFrame.url,
    profileKey: resolution.profileKey,
    urlFixerWarning: resolution.warning,
    exists: loaded.exists,
    profile: loaded.profile,
    advanced
  };

  context.episodeCandidates = episodeCandidates(tabId);

  if (includeFixerSettings) {
    context.urlFixerSettings = resolution.settings;
  }

  return context;
}

async function getSenderContext(sender) {
  if (!sender.tab || !Number.isInteger(sender.tab.id)) {
    throw new Error("Повідомлення не пов'язане з вкладкою.");
  }
  return getTabContext(sender.tab.id);
}

async function broadcastProfile(tabId, topUrl, profileKey, profile, urlFixerWarning = null) {
  try {
    const context = await getTabContext(tabId);
    await chrome.tabs.sendMessage(tabId, {
      type: MESSAGE.PROFILE_UPDATED,
      topUrl: context.topUrl,
      profileKey: context.profileKey,
      urlFixerWarning: context.urlFixerWarning,
      profile: context.profile,
      advanced: context.advanced
    });
  } catch (error) {
    // Вкладка може ще не мати content script або вже завершувати навігацію.
    if (!String(error && error.message).includes("Receiving end does not exist")) {
      console.warn("OpEndSkipper: не вдалося оновити content scripts.", error);
    }
  }
}

function refreshTabProfile(tabId) {
  getTabContext(tabId)
    .then((context) => broadcastProfile(
      context.tabId,
      context.topUrl,
      context.profileKey,
      context.profile,
      context.urlFixerWarning
    ))
    .catch((error) => {
      console.warn("OpEndSkipper: не вдалося оновити профіль після навігації.", error);
    });
}

function selectBestVideoState(candidates) {
  if (candidates.length === 0) {
    return null;
  }

  return candidates.sort((left, right) =>
    Number(right.isPlaying) - Number(left.isPlaying) ||
    right.lastActivity - left.lastActivity ||
    right.area - left.area
  )[0];
}

async function collectVideoState(tabId) {
  const requestId = crypto.randomUUID();

  return new Promise((resolve) => {
    const collection = {
      tabId,
      candidates: [],
      finish() {
        videoStateCollections.delete(requestId);
        resolve(selectBestVideoState(collection.candidates));
      }
    };

    videoStateCollections.set(requestId, collection);

    chrome.tabs.sendMessage(tabId, {
      type: MESSAGE.REQUEST_VIDEO_STATE,
      requestId
    }).catch(() => {
      // Відсутність content script обробляється як відсутність відео.
    });

    setTimeout(collection.finish, 250);
  });
}

async function handleMessage(message, sender) {
  switch (message && message.type) {
    case MESSAGE.GET_PROFILE:
      return getSenderContext(sender);

    case MESSAGE.GET_POPUP_CONTEXT:
      await collectEpisodeSources(message.tabId);
      return getTabContext(message.tabId, true);

    case MESSAGE.COLLECT_EPISODE_SOURCES:
      await collectEpisodeSources(message.tabId);
      return getTabContext(message.tabId, true);

    case MESSAGE.SET_ADVANCED_MODE:
    case MESSAGE.SET_EPISODE_DETECTOR:
    case MESSAGE.SAVE_ADVANCED_RANGES: {
      const current = await getTabContext(message.tabId, true);
      if (message.expectedUrl && message.expectedUrl !== current.topUrl) {
        throw new Error("URL вкладки змінився. Відкрийте popup ще раз.");
      }
      if (message.type === MESSAGE.SET_ADVANCED_MODE) {
        await AdvancedStorage.setMode(current.profileKey, message.mode);
      } else if (message.type === MESSAGE.SET_EPISODE_DETECTOR) {
        await AdvancedStorage.setDetector(current.profileKey, message.detector);
        runtimeEpisodes.delete(message.tabId);
      } else {
        if (!current.advanced.currentEpisode || current.advanced.currentEpisode !== message.episodeId) {
          throw new Error("Поточний Episode ID змінився. Оновіть налаштування.");
        }
        await AdvancedStorage.saveRanges(
          current.profileKey, message.episodeId, message.ranges
        );
      }
      const context = await getTabContext(message.tabId, true);
      await broadcastProfile(
        context.tabId, context.topUrl, context.profileKey,
        context.profile, context.urlFixerWarning
      );
      return context;
    }

    case MESSAGE.COPY_ADVANCED_RANGES: {
      const context = await getTabContext(message.tabId);
      if (message.expectedUrl && message.expectedUrl !== context.topUrl) {
        throw new Error("URL вкладки змінився. Відкрийте popup ще раз.");
      }
      if (!context.advanced.currentEpisode) throw new Error("Episode ID не визначено.");
      return {
        timingKeys: await AdvancedStorage.copyRanges(context.profileKey, context.advanced.currentEpisode)
      };
    }

    case MESSAGE.GET_ADVANCED_CLIPBOARD:
      return { ranges: await AdvancedStorage.getClipboard() };

    case MESSAGE.GET_COPIED_SKIP_SETTINGS:
      return {
        settings: await Profiles.getCopiedSkipSettings()
      };

    case MESSAGE.COPY_SKIP_SETTINGS:
      return {
        settings: await Profiles.copySkipSettings(message.settings)
      };

    case MESSAGE.SAVE_PROFILE: {
      const context = await getTabContext(message.tabId);
      if (message.expectedUrl && message.expectedUrl !== context.topUrl) {
        throw new Error("URL вкладки змінився. Відкрийте popup ще раз.");
      }

      const profile = await Profiles.saveProfile(context.profileKey, message.profile);
      await broadcastProfile(
        context.tabId,
        context.topUrl,
        context.profileKey,
        profile,
        context.urlFixerWarning
      );
      return {
        ...context,
        exists: true,
        profile
      };
    }

    case MESSAGE.SAVE_URL_FIXER_SETTINGS: {
      const current = await getTabContext(message.tabId);
      if (message.expectedUrl && message.expectedUrl !== current.topUrl) {
        throw new Error("URL вкладки змінився. Відкрийте popup ще раз.");
      }

      await UrlFixers.saveUrlFixerRules(message.rules);
      const context = await getTabContext(message.tabId, true);
      await broadcastProfile(
        context.tabId,
        context.topUrl,
        context.profileKey,
        context.profile,
        context.urlFixerWarning
      );
      return context;
    }

    case MESSAGE.PASTE_SKIP_SETTINGS: {
      const context = await getTabContext(message.tabId);
      if (message.expectedUrl && message.expectedUrl !== context.topUrl) {
        throw new Error("URL вкладки змінився. Відкрийте popup ще раз.");
      }

      const copiedSettings = await Profiles.getCopiedSkipSettings();
      if (!copiedSettings) {
        throw new Error("Немає коректних скопійованих налаштувань.");
      }

      const profile = await Profiles.saveProfile(context.profileKey, {
        ...context.profile,
        ...copiedSettings
      });
      await broadcastProfile(
        context.tabId,
        context.topUrl,
        context.profileKey,
        profile,
        context.urlFixerWarning
      );
      return {
        ...context,
        exists: true,
        profile
      };
    }

    case MESSAGE.COLLECT_VIDEO_STATE:
      await getTabContext(message.tabId);
      return {
        video: await collectVideoState(message.tabId)
      };

    default:
      throw new Error("Невідомий тип повідомлення.");
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message && (message.type === MESSAGE.REPORT_EPISODE_SOURCES ||
      message.type === MESSAGE.EPISODE_SOURCES_CHANGED)) {
    if (sender.tab && Number.isInteger(sender.tab.id) && Number.isInteger(sender.frameId)) {
      const tabId = sender.tab.id;
      const before = runtimeEpisodes.get(tabId)?.id || null;
      rememberEpisodeSources(tabId, sender.frameId, message.candidates);
      if (message.type === MESSAGE.EPISODE_SOURCES_CHANGED ||
          !episodeSourceCollections.has(message.requestId)) {
        const refresh = message.type === MESSAGE.EPISODE_SOURCES_CHANGED
          ? collectEpisodeSources(tabId) : Promise.resolve();
        refresh.then(() => getTabContext(tabId)).then((context) => {
          if (context.advanced.currentEpisode !== before) {
            return broadcastProfile(tabId, context.topUrl, context.profileKey, context.profile);
          }
        }).then(() => chrome.runtime.sendMessage({ type: MESSAGE.EPISODE_UPDATED, tabId }))
          .catch(() => {});
      }
    }
    sendResponse({ ok: true });
    return false;
  }
  if (message && message.type === MESSAGE.EPISODE_UPDATED) {
    sendResponse({ ok: true });
    return false;
  }
  if (message && message.type === MESSAGE.REPORT_VIDEO_STATE) {
    const collection = videoStateCollections.get(message.requestId);
    if (
      collection &&
      sender.tab &&
      sender.tab.id === collection.tabId &&
      message.video
    ) {
      collection.candidates.push({
        ...message.video,
        frameId: sender.frameId
      });
    }
    sendResponse({ ok: true });
    return false;
  }

  handleMessage(message, sender)
    .then((data) => sendResponse({ ok: true, data }))
    .catch((error) => {
      console.error("OpEndSkipper:", error);
      sendResponse({
        ok: false,
        error: error && error.message ? error.message : "Невідома помилка."
      });
    });

  return true;
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (!changeInfo.url) {
    return;
  }

  refreshTabProfile(tabId);
  chrome.runtime.sendMessage({ type: MESSAGE.EPISODE_UPDATED, tabId }).catch(() => {});
});

function handleSameDocumentNavigation(details) {
  if (details.frameId === 0 && details.url) {
    refreshTabProfile(details.tabId);
    chrome.runtime.sendMessage({ type: MESSAGE.EPISODE_UPDATED, tabId: details.tabId }).catch(() => {});
  } else if (details.url) {
    collectEpisodeSources(details.tabId).then(() => {
      refreshTabProfile(details.tabId);
      return chrome.runtime.sendMessage({ type: MESSAGE.EPISODE_UPDATED, tabId: details.tabId });
    }).catch(() => {});
  }
}

chrome.webNavigation.onHistoryStateUpdated.addListener(handleSameDocumentNavigation);
chrome.webNavigation.onReferenceFragmentUpdated.addListener(handleSameDocumentNavigation);
chrome.webNavigation.onCommitted.addListener((details) => {
  if (details.frameId === 0) {
    runtimeEpisodes.delete(details.tabId);
    episodeSourcesByTab.delete(details.tabId);
  } else {
    episodeSourcesByTab.get(details.tabId)?.delete(details.frameId);
  }
});
chrome.tabs.onRemoved.addListener((tabId) => {
  runtimeEpisodes.delete(tabId);
  episodeSourcesByTab.delete(tabId);
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === "local") {
    const changedProfiles = Object.entries(changes)
      .filter(([key, change]) =>
        key.startsWith(ADVANCED_PROFILE_PREFIX) &&
        change.newValue && typeof change.newValue.profileKey === "string"
      )
      .map(([, change]) => change.newValue.profileKey);
    if (changedProfiles.length > 0) {
      chrome.tabs.query({}).then((tabs) => {
        for (const tab of tabs) {
          if (!Number.isInteger(tab.id)) continue;
          getTabContext(tab.id).then((context) => {
            if (changedProfiles.includes(context.profileKey)) {
              return broadcastProfile(
                context.tabId, context.topUrl, context.profileKey,
                context.profile, context.urlFixerWarning
              );
            }
          }).catch(() => {});
        }
      }).catch(() => {});
    }
    return;
  }
  if (areaName !== "sync") {
    return;
  }

  const urlFixersChanged = Boolean(changes[URL_FIXER_SETTINGS_KEY]);
  const updatedProfileKeys = Object.entries(changes)
    .filter(([key, change]) =>
      key.startsWith(PROFILE_KEY_PREFIX) &&
      change.newValue &&
      typeof change.newValue.url === "string"
    )
    .map(([, change]) => change.newValue.url);

  if (!urlFixersChanged && updatedProfileKeys.length === 0) {
    return;
  }

  chrome.tabs.query({}).then((tabs) => {
    for (const tab of tabs) {
      if (!Number.isInteger(tab.id)) {
        continue;
      }

      if (urlFixersChanged) {
        refreshTabProfile(tab.id);
        continue;
      }

      getTabContext(tab.id).then((context) => {
        if (updatedProfileKeys.includes(context.profileKey)) {
          broadcastProfile(
            context.tabId,
            context.topUrl,
            context.profileKey,
            context.profile,
            context.urlFixerWarning
          );
        }
      }).catch((error) => {
        console.warn("OpEndSkipper: не вдалося оновити sync-профіль вкладки.", error);
      });
    }
  }).catch((error) => {
    console.warn("OpEndSkipper: не вдалося поширити sync-оновлення.", error);
  });
});

function removeLegacySettings() {
  Promise.all([
    Profiles.removeLegacySettings(),
    UrlFixers.loadUrlFixerSettings()
  ]).catch((error) => {
    console.warn("OpEndSkipper: не вдалося ініціалізувати глобальні налаштування.", error);
  });
}

chrome.runtime.onInstalled.addListener(removeLegacySettings);
chrome.runtime.onStartup.addListener(removeLegacySettings);
