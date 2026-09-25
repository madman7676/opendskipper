importScripts(
  "../shared/constants.js",
  "../shared/url-fixers.js",
  "../shared/profiles.js"
);

const {
  MESSAGE,
  PROFILE_KEY_PREFIX,
  Profiles,
  URL_FIXER_SETTINGS_KEY,
  UrlFixers
} = globalThis.OpenDSkipper;

const videoStateCollections = new Map();

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
  const context = {
    tabId,
    topUrl: topFrame.url,
    profileKey: resolution.profileKey,
    urlFixerWarning: resolution.warning,
    exists: loaded.exists,
    profile: loaded.profile
  };

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
    await chrome.tabs.sendMessage(tabId, {
      type: MESSAGE.PROFILE_UPDATED,
      topUrl,
      profileKey,
      urlFixerWarning,
      profile
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
      return getTabContext(message.tabId, true);

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
});

function handleSameDocumentNavigation(details) {
  if (details.frameId === 0 && details.url) {
    refreshTabProfile(details.tabId);
  }
}

chrome.webNavigation.onHistoryStateUpdated.addListener(handleSameDocumentNavigation);
chrome.webNavigation.onReferenceFragmentUpdated.addListener(handleSameDocumentNavigation);

chrome.storage.onChanged.addListener((changes, areaName) => {
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
