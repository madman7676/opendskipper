importScripts("../shared/constants.js", "../shared/profiles.js");

const {
  MESSAGE,
  PROFILE_KEY_PREFIX,
  Profiles
} = globalThis.OpenDSkipper;

const videoStateCollections = new Map();

async function getTabContext(tabId) {
  if (!Number.isInteger(tabId)) {
    throw new Error("Некоректний ідентифікатор вкладки.");
  }

  const tab = await chrome.tabs.get(tabId);
  if (!tab.url) {
    throw new Error("Не вдалося визначити URL активної вкладки.");
  }

  const loaded = await Profiles.loadProfile(tab.url);
  return {
    tabId: tab.id,
    topUrl: tab.url,
    exists: loaded.exists,
    profile: loaded.profile
  };
}

async function getSenderContext(sender) {
  if (!sender.tab || !Number.isInteger(sender.tab.id)) {
    throw new Error("Повідомлення не пов'язане з вкладкою.");
  }
  return getTabContext(sender.tab.id);
}

async function broadcastProfile(tabId, topUrl, profile) {
  try {
    await chrome.tabs.sendMessage(tabId, {
      type: MESSAGE.PROFILE_UPDATED,
      topUrl,
      profile
    });
  } catch (error) {
    // Вкладка може ще не мати content script або вже завершувати навігацію.
    if (!String(error && error.message).includes("Receiving end does not exist")) {
      console.warn("OpEndSkipper: не вдалося оновити content scripts.", error);
    }
  }
}

function refreshTabProfile(tabId, topUrl) {
  Profiles.loadProfile(topUrl)
    .then(({ profile }) => broadcastProfile(tabId, topUrl, profile))
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
      return getTabContext(message.tabId);

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

      const profile = await Profiles.saveProfile(context.topUrl, message.profile);
      await broadcastProfile(context.tabId, context.topUrl, profile);
      return {
        ...context,
        exists: true,
        profile
      };
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

      const profile = await Profiles.saveProfile(context.topUrl, {
        ...context.profile,
        ...copiedSettings
      });
      await broadcastProfile(context.tabId, context.topUrl, profile);
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

  refreshTabProfile(tabId, changeInfo.url);
});

function handleSameDocumentNavigation(details) {
  if (details.frameId === 0 && details.url) {
    refreshTabProfile(details.tabId, details.url);
  }
}

chrome.webNavigation.onHistoryStateUpdated.addListener(handleSameDocumentNavigation);
chrome.webNavigation.onReferenceFragmentUpdated.addListener(handleSameDocumentNavigation);

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "sync") {
    return;
  }

  const updatedProfiles = Object.entries(changes)
    .filter(([key, change]) =>
      key.startsWith(PROFILE_KEY_PREFIX) &&
      change.newValue &&
      typeof change.newValue.url === "string"
    )
    .map(([, change]) => ({
      url: change.newValue.url,
      profile: Profiles.sanitizeProfile(change.newValue.profile)
    }));

  if (updatedProfiles.length === 0) {
    return;
  }

  chrome.tabs.query({}).then((tabs) => {
    for (const tab of tabs) {
      const updated = updatedProfiles.find((item) => item.url === tab.url);
      if (updated && Number.isInteger(tab.id)) {
        broadcastProfile(tab.id, updated.url, updated.profile);
      }
    }
  }).catch((error) => {
    console.warn("OpEndSkipper: не вдалося поширити sync-оновлення.", error);
  });
});

function removeLegacySettings() {
  Profiles.removeLegacySettings().catch((error) => {
    console.warn("OpEndSkipper: не вдалося видалити старі глобальні налаштування.", error);
  });
}

chrome.runtime.onInstalled.addListener(removeLegacySettings);
chrome.runtime.onStartup.addListener(removeLegacySettings);
