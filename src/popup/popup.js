(function initializePopup() {
  "use strict";

  const { DEFAULT_PROFILE, MESSAGE } = globalThis.OpenDSkipper;

  const elements = {
    pageUrl: document.getElementById("pageUrl"),
    enabled: document.getElementById("enabled"),
    skipStart: document.getElementById("skipStart"),
    skipEnd: document.getElementById("skipEnd"),
    useCurrentStart: document.getElementById("useCurrentStart"),
    useCurrentEnd: document.getElementById("useCurrentEnd"),
    calcStartMinutes: document.getElementById("calcStartMinutes"),
    calcStartSeconds: document.getElementById("calcStartSeconds"),
    calcEndMinutes: document.getElementById("calcEndMinutes"),
    calcEndSeconds: document.getElementById("calcEndSeconds"),
    calculateDuration: document.getElementById("calculateDuration"),
    calculationResult: document.getElementById("calculationResult"),
    copySkipSettings: document.getElementById("copySkipSettings"),
    pasteSkipSettings: document.getElementById("pasteSkipSettings"),
    save: document.getElementById("save"),
    status: document.getElementById("status")
  };

  let tabId = null;
  let topUrl = null;
  let initializing = true;
  let contextReady = false;
  let hasCopiedSkipSettings = false;

  function setStatus(text, isError = false) {
    elements.status.textContent = text;
    elements.status.classList.toggle("error", isError);
  }

  function setBusy(busy) {
    elements.enabled.disabled = busy;
    elements.skipStart.disabled = busy;
    elements.skipEnd.disabled = busy;
    elements.useCurrentStart.disabled = busy;
    elements.useCurrentEnd.disabled = busy;
    elements.save.disabled = busy;
    elements.copySkipSettings.disabled = busy || !contextReady;
    elements.pasteSkipSettings.disabled = busy || !contextReady || !hasCopiedSkipSettings;
    elements.pasteSkipSettings.title = hasCopiedSkipSettings
      ? "Вставити часові налаштування"
      : "Спочатку скопіюйте часові налаштування";
  }

  function readSeconds(input) {
    const value = Number(input.value);
    return Number.isFinite(value) && value >= 0 ? value : 0;
  }

  function readProfile() {
    return {
      enabled: elements.enabled.checked,
      skipStart: readSeconds(elements.skipStart),
      skipEnd: readSeconds(elements.skipEnd)
    };
  }

  function renderProfile(profile) {
    const safe = profile || DEFAULT_PROFILE;
    elements.enabled.checked = safe.enabled === true;
    elements.skipStart.value = Math.max(0, Number(safe.skipStart) || 0);
    elements.skipEnd.value = Math.max(0, Number(safe.skipEnd) || 0);
  }

  async function sendMessage(message) {
    const response = await chrome.runtime.sendMessage(message);
    if (!response || !response.ok) {
      throw new Error(response && response.error ? response.error : "Операція не виконана.");
    }
    return response.data;
  }

  async function refreshCopiedSkipSettingsState() {
    const copied = await sendMessage({
      type: MESSAGE.GET_COPIED_SKIP_SETTINGS
    });
    hasCopiedSkipSettings = copied.settings !== null;
  }

  async function loadContext() {
    setBusy(true);
    setStatus("");

    try {
      const [tab] = await chrome.tabs.query({
        active: true,
        currentWindow: true
      });

      if (!tab || !Number.isInteger(tab.id) || !tab.url) {
        throw new Error("Активну вкладку не знайдено.");
      }

      tabId = tab.id;
      topUrl = tab.url;
      const context = await sendMessage({
        type: MESSAGE.GET_POPUP_CONTEXT,
        tabId
      });

      topUrl = context.topUrl;
      contextReady = true;
      elements.pageUrl.textContent = topUrl;
      elements.pageUrl.title = topUrl;
      renderProfile(context.profile);
      await refreshCopiedSkipSettingsState();
      setStatus(context.exists ? "Профіль URL завантажено." : "Новий URL: стандартно вимкнено.");
    } catch (error) {
      renderProfile(DEFAULT_PROFILE);
      elements.pageUrl.textContent = "URL недоступний";
      setStatus(error.message, true);
    } finally {
      initializing = false;
      setBusy(!contextReady);
    }
  }

  async function saveProfile(successMessage = "Налаштування збережено.") {
    if (initializing || tabId === null || topUrl === null) {
      return;
    }

    setBusy(true);
    setStatus("");
    try {
      const context = await sendMessage({
        type: MESSAGE.SAVE_PROFILE,
        tabId,
        expectedUrl: topUrl,
        profile: readProfile()
      });
      topUrl = context.topUrl;
      renderProfile(context.profile);
      setStatus(successMessage);
    } catch (error) {
      setStatus(error.message, true);
    } finally {
      setBusy(false);
    }
  }

  async function getVideoState() {
    setBusy(true);
    setStatus("Шукаю активне відео…");
    try {
      const result = await sendMessage({
        type: MESSAGE.COLLECT_VIDEO_STATE,
        tabId
      });
      if (!result.video) {
        throw new Error("Відео в цій вкладці не знайдено.");
      }
      return result.video;
    } finally {
      setBusy(false);
    }
  }

  elements.save.addEventListener("click", () => saveProfile());

  elements.enabled.addEventListener("change", () => {
    saveProfile(elements.enabled.checked
      ? "OpEndSkipper увімкнено для цього URL."
      : "OpEndSkipper вимкнено для цього URL.");
  });

  elements.copySkipSettings.addEventListener("click", async () => {
    setBusy(true);
    setStatus("");
    try {
      const profile = readProfile();
      await sendMessage({
        type: MESSAGE.COPY_SKIP_SETTINGS,
        settings: {
          skipStart: profile.skipStart,
          skipEnd: profile.skipEnd
        }
      });
      hasCopiedSkipSettings = true;
      setStatus("Скопійовано.");
    } catch (error) {
      setStatus(error.message, true);
    } finally {
      setBusy(false);
    }
  });

  elements.pasteSkipSettings.addEventListener("click", async () => {
    setBusy(true);
    setStatus("");
    try {
      const context = await sendMessage({
        type: MESSAGE.PASTE_SKIP_SETTINGS,
        tabId,
        expectedUrl: topUrl
      });
      topUrl = context.topUrl;
      renderProfile(context.profile);
      setStatus("Застосовано.");
    } catch (error) {
      try {
        await refreshCopiedSkipSettingsState();
      } catch {
        hasCopiedSkipSettings = false;
      }
      setStatus(error.message, true);
    } finally {
      setBusy(false);
    }
  });

  elements.useCurrentStart.addEventListener("click", async () => {
    try {
      const video = await getVideoState();
      elements.skipStart.value = Math.max(0, Math.floor(video.currentTime));
      setStatus("Початок взято з активного відео. Натисніть «Зберегти».");
    } catch (error) {
      setStatus(error.message, true);
    }
  });

  elements.useCurrentEnd.addEventListener("click", async () => {
    try {
      const video = await getVideoState();
      if (!Number.isFinite(video.duration)) {
        throw new Error("Тривалість активного відео ще невідома.");
      }
      elements.skipEnd.value = Math.max(
        0,
        Math.floor(video.duration - video.currentTime)
      );
      setStatus("Залишок взято з активного відео. Натисніть «Зберегти».");
    } catch (error) {
      setStatus(error.message, true);
    }
  });

  elements.calculateDuration.addEventListener("click", () => {
    const start = readSeconds(elements.calcStartMinutes) * 60 +
      readSeconds(elements.calcStartSeconds);
    const end = readSeconds(elements.calcEndMinutes) * 60 +
      readSeconds(elements.calcEndSeconds);
    elements.calculationResult.textContent = `Різниця: ${end - start} с`;
  });

  loadContext();
})();
