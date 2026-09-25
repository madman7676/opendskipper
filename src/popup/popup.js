(function initializePopup() {
  "use strict";

  const {
    DEFAULT_PROFILE,
    MESSAGE,
    Time,
    TimeField,
    AdvancedUi,
    UrlFixers
  } = globalThis.OpenDSkipper;

  const elements = {
    popupContent: document.getElementById("popupContent"),
    popupOverlay: document.getElementById("popupOverlay"),
    popupSpinner: document.getElementById("popupSpinner"),
    popupOverlayMessage: document.getElementById("popupOverlayMessage"),
    pageUrl: document.getElementById("pageUrl"),
    mainSettingsContent: document.getElementById("mainSettingsContent"),
    settingsOverlay: document.getElementById("settingsOverlay"),
    settingsOverlayMessage: document.getElementById("settingsOverlayMessage"),
    modeSwitch: document.getElementById("modeSwitch"),
    easySection: document.getElementById("easySection"),
    advancedSection: document.getElementById("advancedSection"),
    enabled: document.getElementById("enabled"),
    skipStart: document.getElementById("skipStart"),
    skipStartFraction: document.getElementById("skipStartFraction"),
    skipEnd: document.getElementById("skipEnd"),
    skipEndFraction: document.getElementById("skipEndFraction"),
    useCurrentStart: document.getElementById("useCurrentStart"),
    useCurrentEnd: document.getElementById("useCurrentEnd"),
    copySkipSettings: document.getElementById("copySkipSettings"),
    pasteSkipSettings: document.getElementById("pasteSkipSettings"),
    save: document.getElementById("save"),
    toast: document.getElementById("toast"),
    toastMessage: document.getElementById("toastMessage"),
    toastClose: document.getElementById("toastClose"),
    urlFixerControls: document.getElementById("urlFixerControls"),
    enableAllFixers: document.getElementById("enableAllFixers"),
    disableAllFixers: document.getElementById("disableAllFixers"),
    urlFixerList: document.getElementById("urlFixerList"),
    addFixerForm: document.getElementById("addFixerForm"),
    addUrlFixer: document.getElementById("addUrlFixer"),
    previewOriginalUrl: document.getElementById("previewOriginalUrl"),
    previewProfileKey: document.getElementById("previewProfileKey")
  };

  let tabId = null;
  let topUrl = null;
  let profileKey = null;
  let urlFixerWarning = null;
  let shownFixerWarning = null;
  let urlFixerSettings = { schemaVersion: 1, rules: [] };
  let initializing = true;
  let contextReady = false;
  let busy = false;
  let videoAvailability = "checking";
  let videoCheckInFlight = false;
  let videoPollTimer = null;
  let hasCopiedSkipSettings = false;
  let editorState = null;
  let pendingDeleteId = null;
  let currentProfile = { ...DEFAULT_PROFILE };
  let toastTimer = null;
  const easyTimeFields = {
    skipStart: TimeField.create(elements.skipStart, elements.skipStartFraction),
    skipEnd: TimeField.create(elements.skipEnd, elements.skipEndFraction)
  };
  let currentMode = "easy";

  const operationLabels = Object.freeze({
    [UrlFixers.OPERATION.TRUNCATE_AFTER]: "Відкинути все після",
    [UrlFixers.OPERATION.TRUNCATE_AFTER_LAST]: "Відкинути все після останнього входження",
    [UrlFixers.OPERATION.REMOVE_EXACT]: "Видалити точний текст",
    [UrlFixers.OPERATION.REPLACE_EXACT]: "Замінити точний текст"
  });

  const positionLabels = Object.freeze({
    [UrlFixers.POSITION.START]: "на початку",
    [UrlFixers.POSITION.END]: "в кінці",
    [UrlFixers.POSITION.ANYWHERE]: "усюди"
  });

  function dismissToast() {
    if (toastTimer !== null) {
      clearTimeout(toastTimer);
      toastTimer = null;
    }
    elements.toast.hidden = true;
  }

  function showToast(message, type = "info") {
    dismissToast();
    if (!message) return;
    const safeType = ["success", "error", "info"].includes(type) ? type : "info";
    elements.toastMessage.textContent = message;
    elements.toast.setAttribute("data-type", safeType);
    elements.toast.setAttribute("role", safeType === "error" ? "alert" : "status");
    elements.toast.setAttribute("aria-live", safeType === "error" ? "assertive" : "polite");
    elements.toast.hidden = false;
    toastTimer = setTimeout(dismissToast, 7000);
  }

  function setStatus(text, isError = false, type = "success") {
    showToast(text, isError ? "error" : type);
  }

  elements.toastClose.addEventListener("click", dismissToast);

  function setPopupState(state, errorMessage = "") {
    const ready = state === "ready";
    elements.popupContent.inert = !ready;
    elements.popupContent.setAttribute("aria-busy", String(state === "loading"));
    elements.popupOverlay.hidden = ready;
    elements.popupSpinner.hidden = state !== "loading";
    elements.popupOverlayMessage.textContent = state === "error"
      ? `Не вдалося завантажити URL. ${errorMessage}`
      : "Завантаження URL…";
  }

  function updateFixerActionStates() {
    const rulesUnavailable =
      busy || !contextReady || urlFixerSettings.rules.length === 0 ||
      editorState !== null ||
      pendingDeleteId !== null;
    elements.enableAllFixers.disabled = rulesUnavailable;
    elements.disableAllFixers.disabled = rulesUnavailable;
    elements.addUrlFixer.disabled =
      busy || !contextReady || editorState !== null ||
      pendingDeleteId !== null ||
      urlFixerSettings.rules.length >= UrlFixers.MAX_RULES;
  }

  function setBusy(nextBusy) {
    busy = nextBusy;
    const unavailable = busy || !contextReady;
    const settingsUnavailable = unavailable || videoAvailability !== "available";
    elements.modeSwitch.disabled = unavailable;
    elements.mainSettingsContent.inert = settingsUnavailable;
    elements.settingsOverlay.hidden = !contextReady || videoAvailability === "available";
    elements.settingsOverlayMessage.textContent = videoAvailability === "missing"
      ? "Відео на сторінці не знайдено" : "Перевірка відео…";
    elements.advancedSection.inert = settingsUnavailable;
    elements.enabled.disabled = unavailable;
    elements.skipStart.disabled = settingsUnavailable;
    elements.skipEnd.disabled = settingsUnavailable;
    elements.useCurrentStart.disabled = settingsUnavailable;
    elements.useCurrentEnd.disabled = settingsUnavailable;
    elements.save.disabled = settingsUnavailable;
    elements.copySkipSettings.disabled = settingsUnavailable;
    elements.pasteSkipSettings.disabled = settingsUnavailable || !hasCopiedSkipSettings;
    elements.pasteSkipSettings.title = hasCopiedSkipSettings
      ? "Вставити часові налаштування"
      : "Спочатку скопіюйте часові налаштування";
    elements.urlFixerControls.disabled = busy || !contextReady;
    updateFixerActionStates();
  }

  function readProfile() {
    return {
      enabled: elements.enabled.checked,
      skipStart: easyTimeFields.skipStart.get() ?? 0,
      skipEnd: easyTimeFields.skipEnd.get() ?? 0
    };
  }

  function renderTimeField(key, seconds) {
    easyTimeFields[key].set(seconds);
  }

  function renderProfile(profile) {
    const safe = profile || DEFAULT_PROFILE;
    elements.enabled.checked = safe.enabled === true;
    renderTimeField("skipStart", safe.skipStart);
    renderTimeField("skipEnd", safe.skipEnd);
  }

  function applyContext(context, includeFixerSettings = false, resetAdvancedDraft = false) {
    topUrl = context.topUrl;
    profileKey = context.profileKey;
    urlFixerWarning = context.urlFixerWarning || null;
    elements.pageUrl.textContent = profileKey;
    elements.pageUrl.title = profileKey;
    currentProfile = { ...context.profile };
    renderProfile(context.profile);
    currentMode = context.advanced && context.advanced.mode === "advanced" ? "advanced" : "easy";
    elements.easySection.hidden = currentMode !== "easy";
    elements.advancedSection.hidden = currentMode !== "advanced";
    elements.modeSwitch.checked = currentMode === "advanced";
    advancedUi.render(context, resetAdvancedDraft);

    if (includeFixerSettings && context.urlFixerSettings) {
      urlFixerSettings = context.urlFixerSettings;
    }
  }

  async function sendMessage(message) {
    if (Object.hasOwn(message, "tabId") && !Number.isInteger(message.tabId)) {
      throw new Error("Контекст вкладки недоступний.");
    }
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

  function clipText(value, limit = 48) {
    return value.length <= limit ? value : `${value.slice(0, limit)}…`;
  }

  function describeRule(rule, clip = true) {
    const value = clip ? clipText(rule.value) : rule.value;
    if (rule.operation === UrlFixers.OPERATION.TRUNCATE_AFTER) {
      return `Відкинути все після “${value}”`;
    }
    if (rule.operation === UrlFixers.OPERATION.TRUNCATE_AFTER_LAST) {
      return `Відкинути все після останнього “${value}”`;
    }

    const position = positionLabels[rule.position] || "";
    if (rule.operation === UrlFixers.OPERATION.REMOVE_EXACT) {
      return `Видалити “${value}” ${position}`;
    }

    const replacement = clip ? clipText(rule.replacement) : rule.replacement;
    return `Замінити “${value}” на “${replacement}” ${position}`;
  }

  function createButton(text, label, className = "secondary compact") {
    const button = document.createElement("button");
    button.type = "button";
    button.className = className;
    button.textContent = text;
    button.title = label;
    button.setAttribute("aria-label", label);
    return button;
  }

  function focusRuleControl(ruleId, preferredAction) {
    const controls = Array.from(elements.urlFixerList.querySelectorAll("button, input"))
      .filter((control) => control.dataset.ruleId === ruleId && !control.disabled);
    const preferred = controls.find((control) => control.dataset.action === preferredAction);
    const fallback = controls.find((control) => control.dataset.action === "edit") || controls[0];
    (preferred || fallback || elements.addUrlFixer).focus();
  }

  function renderPreview() {
    const preview = topUrl
      ? UrlFixers.applyUrlFixers(topUrl, urlFixerSettings.rules)
      : { profileKey: "", warning: null };
    const shownKey = profileKey || preview.profileKey;
    const warning = urlFixerWarning || preview.warning;

    elements.previewOriginalUrl.textContent = topUrl || "—";
    elements.previewOriginalUrl.title = topUrl || "";
    elements.previewProfileKey.textContent = shownKey || "—";
    elements.previewProfileKey.title = shownKey || "";
    if (warning !== shownFixerWarning) {
      shownFixerWarning = warning;
      if (warning) showToast(warning, "error");
    }
  }

  function createSelect(options, selectedValue) {
    const select = document.createElement("select");
    for (const [value, label] of options) {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = label;
      option.selected = value === selectedValue;
      select.append(option);
    }
    return select;
  }

  function createFormField(labelText, control, errorKey) {
    const wrapper = document.createElement("div");
    const label = document.createElement("label");
    label.textContent = labelText;
    label.append(control);
    control.addEventListener("input", () => {
      editorState.errors[errorKey] = "";
    });
    wrapper.append(label);
    return wrapper;
  }

  function renderRuleForm(container) {
    const form = document.createElement("div");
    form.className = "rule-form";
    const draft = editorState.draft;

    const operation = createSelect([
      [UrlFixers.OPERATION.TRUNCATE_AFTER, operationLabels[UrlFixers.OPERATION.TRUNCATE_AFTER]],
      [UrlFixers.OPERATION.TRUNCATE_AFTER_LAST, operationLabels[UrlFixers.OPERATION.TRUNCATE_AFTER_LAST]],
      [UrlFixers.OPERATION.REMOVE_EXACT, operationLabels[UrlFixers.OPERATION.REMOVE_EXACT]],
      [UrlFixers.OPERATION.REPLACE_EXACT, operationLabels[UrlFixers.OPERATION.REPLACE_EXACT]]
    ], draft.operation);
    operation.addEventListener("change", () => {
      editorState.draft.operation = operation.value;
      editorState.errors = {};
      renderFixerUi();
    });
    form.append(createFormField("Операція", operation, "operation"));

    if (
      draft.operation !== UrlFixers.OPERATION.TRUNCATE_AFTER &&
      draft.operation !== UrlFixers.OPERATION.TRUNCATE_AFTER_LAST
    ) {
      const position = createSelect([
        [UrlFixers.POSITION.START, "На початку"],
        [UrlFixers.POSITION.END, "В кінці"],
        [UrlFixers.POSITION.ANYWHERE, "Усюди"]
      ], draft.position);
      position.addEventListener("change", () => {
        editorState.draft.position = position.value;
      });
      form.append(createFormField("Область", position, "position"));
    }

    const value = document.createElement("input");
    value.type = "text";
    value.maxLength = UrlFixers.MAX_FIELD_LENGTH;
    value.value = draft.value;
    value.addEventListener("input", () => {
      editorState.draft.value = value.value;
    });
    form.append(createFormField("Точний текст", value, "value"));

    if (draft.operation === UrlFixers.OPERATION.REPLACE_EXACT) {
      const replacement = document.createElement("input");
      replacement.type = "text";
      replacement.maxLength = UrlFixers.MAX_FIELD_LENGTH;
      replacement.value = draft.replacement;
      replacement.addEventListener("input", () => {
        editorState.draft.replacement = replacement.value;
      });
      form.append(createFormField("Замінити на", replacement, "replacement"));
    }

    const actions = document.createElement("div");
    actions.className = "form-actions";
    const save = createButton("Зберегти", "Зберегти правило");
    const cancel = createButton("Скасувати", "Скасувати редагування");
    save.addEventListener("click", saveEditor);
    cancel.addEventListener("click", cancelEditor);
    actions.append(cancel, save);
    form.append(actions);
    container.append(form);
  }

  function renderDeleteConfirmation(item, rule) {
    const confirmation = document.createElement("div");
    confirmation.className = "delete-confirmation";
    const text = document.createElement("span");
    text.textContent = "Видалити правило?";
    const confirm = createButton("Видалити", "Підтвердити видалення правила");
    const cancel = createButton("Скасувати", "Скасувати видалення правила");
    confirm.addEventListener("click", () => deleteRule(rule.id));
    cancel.addEventListener("click", () => {
      pendingDeleteId = null;
      renderFixerUi();
      focusRuleControl(rule.id, "delete");
    });
    confirmation.append(text, cancel, confirm);
    item.append(confirmation);
  }

  function renderRule(rule, index) {
    const item = document.createElement("li");
    item.className = "fixer-rule";

    if (editorState && editorState.mode === "edit" && editorState.ruleId === rule.id) {
      renderRuleForm(item);
      return item;
    }

    const summary = document.createElement("div");
    summary.className = "rule-summary";
    const enabled = document.createElement("input");
    enabled.type = "checkbox";
    enabled.className = "rule-enabled";
    enabled.checked = rule.enabled;
    enabled.title = "Увімкнути або вимкнути правило";
    enabled.setAttribute("aria-label", `Увімкнути правило: ${describeRule(rule, false)}`);
    enabled.dataset.ruleId = rule.id;
    enabled.dataset.action = "toggle";
    enabled.disabled = editorState !== null || pendingDeleteId !== null;
    enabled.addEventListener("change", () => toggleRule(rule.id, enabled.checked));

    const description = document.createElement("span");
    description.className = "rule-description";
    description.textContent = describeRule(rule);
    description.title = describeRule(rule, false);

    const up = createButton("↑", "Перемістити правило вгору", "icon-button");
    const down = createButton("↓", "Перемістити правило вниз", "icon-button");
    const edit = createButton("✎", "Редагувати правило", "icon-button");
    const remove = createButton("🗑", "Видалити правило", "icon-button");
    for (const [button, action] of [[up, "up"], [down, "down"], [edit, "edit"], [remove, "delete"]]) {
      button.dataset.ruleId = rule.id;
      button.dataset.action = action;
      button.disabled = editorState !== null || pendingDeleteId !== null;
    }
    up.disabled = up.disabled || index === 0;
    down.disabled = down.disabled || index === urlFixerSettings.rules.length - 1;
    up.addEventListener("click", () => moveRule(index, -1, "up"));
    down.addEventListener("click", () => moveRule(index, 1, "down"));
    edit.addEventListener("click", () => startEditing(rule));
    remove.addEventListener("click", () => {
      pendingDeleteId = rule.id;
      renderFixerUi();
    });

    summary.append(enabled, description, up, down, edit, remove);
    item.append(summary);
    if (pendingDeleteId === rule.id) {
      renderDeleteConfirmation(item, rule);
    }
    return item;
  }

  function renderFixerUi() {
    elements.urlFixerList.replaceChildren();
    if (urlFixerSettings.rules.length === 0) {
      const empty = document.createElement("li");
      empty.className = "empty-rules";
      empty.textContent = "Правил ще немає.";
      elements.urlFixerList.append(empty);
    } else {
      urlFixerSettings.rules.forEach((rule, index) => {
        elements.urlFixerList.append(renderRule(rule, index));
      });
    }

    elements.addFixerForm.replaceChildren();
    if (editorState && editorState.mode === "add") {
      renderRuleForm(elements.addFixerForm);
    }
    updateFixerActionStates();
    renderPreview();
  }

  function startEditing(rule) {
    pendingDeleteId = null;
    editorState = {
      mode: "edit",
      ruleId: rule.id,
      enabled: rule.enabled,
      draft: {
        operation: rule.operation,
        position: rule.position || UrlFixers.POSITION.ANYWHERE,
        value: rule.value,
        replacement: rule.replacement || ""
      },
      errors: {}
    };
    renderFixerUi();
  }

  function startAdding() {
    pendingDeleteId = null;
    editorState = {
      mode: "add",
      ruleId: null,
      enabled: true,
      draft: {
        operation: UrlFixers.OPERATION.TRUNCATE_AFTER,
        position: UrlFixers.POSITION.ANYWHERE,
        value: "",
        replacement: ""
      },
      errors: {}
    };
    renderFixerUi();
  }

  function cancelEditor() {
    const ruleId = editorState && editorState.ruleId;
    editorState = null;
    renderFixerUi();
    if (ruleId) {
      focusRuleControl(ruleId, "edit");
    } else {
      elements.addUrlFixer.focus();
    }
  }

  function validateEditor() {
    const draft = editorState.draft;
    const errors = {};
    if (!draft.value) {
      errors.value = "Введіть непорожній точний текст.";
    } else if (draft.value.length > UrlFixers.MAX_FIELD_LENGTH) {
      errors.value = `Максимум ${UrlFixers.MAX_FIELD_LENGTH} символів.`;
    }
    if (
      draft.operation === UrlFixers.OPERATION.REPLACE_EXACT &&
      draft.replacement.length > UrlFixers.MAX_FIELD_LENGTH
    ) {
      errors.replacement = `Максимум ${UrlFixers.MAX_FIELD_LENGTH} символів.`;
    }
    editorState.errors = errors;
    return Object.keys(errors).length === 0;
  }

  async function saveEditor() {
    if (!validateEditor()) {
      renderFixerUi();
      showToast(Object.values(editorState.errors).join(" "), "error");
      return;
    }

    const draft = editorState.draft;
    const values = {
      operation: draft.operation,
      position: draft.position,
      value: draft.value,
      replacement: draft.replacement
    };
    let nextRules;
    let focusRuleId;

    if (editorState.mode === "add") {
      const rule = UrlFixers.createRule(values);
      if (!rule) {
        editorState.errors.value = "Правило містить некоректні дані.";
        renderFixerUi();
        showToast(editorState.errors.value, "error");
        return;
      }
      nextRules = [...urlFixerSettings.rules, rule];
      focusRuleId = rule.id;
    } else {
      focusRuleId = editorState.ruleId;
      const rule = UrlFixers.normalizeRule({
        ...values,
        id: editorState.ruleId,
        enabled: editorState.enabled
      });
      if (!rule) {
        editorState.errors.value = "Правило містить некоректні дані.";
        renderFixerUi();
        showToast(editorState.errors.value, "error");
        return;
      }
      nextRules = urlFixerSettings.rules.map((current) =>
        current.id === editorState.ruleId ? rule : current
      );
    }

    await persistRules(nextRules, {
      successMessage: "Правило збережено.",
      focusRuleId,
      focusAction: "edit",
      closeEditor: true
    });
  }

  async function persistRules(nextRules, options = {}) {
    setBusy(true);
    setStatus("");
    let succeeded = false;
    try {
      const context = await sendMessage({
        type: MESSAGE.SAVE_URL_FIXER_SETTINGS,
        tabId,
        expectedUrl: topUrl,
        rules: nextRules
      });
      applyContext(context, true);
      if (options.closeEditor !== false) {
        editorState = null;
      }
      pendingDeleteId = null;
      setStatus(options.successMessage || "URL-фіксери збережено.");
      succeeded = true;
    } catch (error) {
      setStatus(error.message, true);
    } finally {
      setBusy(false);
      renderFixerUi();
    }

    if (succeeded && options.focusRuleId) {
      focusRuleControl(options.focusRuleId, options.focusAction);
    } else if (succeeded && options.focusAdd) {
      elements.addUrlFixer.focus();
    }
    return succeeded;
  }

  function toggleRule(ruleId, enabled) {
    const nextRules = urlFixerSettings.rules.map((rule) =>
      rule.id === ruleId ? { ...rule, enabled } : rule
    );
    persistRules(nextRules, {
      successMessage: enabled ? "Правило увімкнено." : "Правило вимкнено.",
      focusRuleId: ruleId,
      focusAction: "toggle"
    });
  }

  function moveRule(index, offset, action) {
    const targetIndex = index + offset;
    if (targetIndex < 0 || targetIndex >= urlFixerSettings.rules.length) {
      return;
    }
    const nextRules = [...urlFixerSettings.rules];
    const [rule] = nextRules.splice(index, 1);
    nextRules.splice(targetIndex, 0, rule);
    persistRules(nextRules, {
      successMessage: "Порядок правил змінено.",
      focusRuleId: rule.id,
      focusAction: action
    });
  }

  function deleteRule(ruleId) {
    const index = urlFixerSettings.rules.findIndex((rule) => rule.id === ruleId);
    const nextRules = urlFixerSettings.rules.filter((rule) => rule.id !== ruleId);
    const nextFocusRule = nextRules[Math.min(index, nextRules.length - 1)];
    persistRules(nextRules, {
      successMessage: "Правило видалено.",
      focusRuleId: nextFocusRule && nextFocusRule.id,
      focusAction: "delete",
      focusAdd: !nextFocusRule
    });
  }

  function setAllRules(enabled) {
    if (urlFixerSettings.rules.length === 0) {
      return;
    }
    persistRules(
      urlFixerSettings.rules.map((rule) => ({ ...rule, enabled })),
      { successMessage: enabled ? "Усі правила увімкнено." : "Усі правила вимкнено." }
    );
  }

  async function refreshVideoAvailability() {
    if (!contextReady || tabId === null || videoCheckInFlight) return;
    videoCheckInFlight = true;
    const checkedTabId = tabId;
    try {
      const result = await sendMessage({
        type: MESSAGE.COLLECT_VIDEO_STATE,
        tabId: checkedTabId
      });
      if (tabId === checkedTabId) {
        videoAvailability = result.video ? "available" : "missing";
      }
    } catch {
      if (tabId === checkedTabId) videoAvailability = "missing";
    } finally {
      videoCheckInFlight = false;
      setBusy(busy);
    }
  }

  async function loadContext() {
    setPopupState("loading");
    videoAvailability = "checking";
    setBusy(true);
    setStatus("");

    try {
      const currentWindowTabs = await chrome.tabs.query({
        active: true,
        currentWindow: true
      });
      let tab = currentWindowTabs.find((candidate) =>
        Number.isInteger(candidate.id) && typeof candidate.url === "string" && candidate.url.length > 0
      );
      if (!tab) {
        const focusedWindowTabs = await chrome.tabs.query({
          active: true,
          lastFocusedWindow: true
        });
        tab = focusedWindowTabs.find((candidate) =>
          Number.isInteger(candidate.id) && typeof candidate.url === "string" && candidate.url.length > 0
        );
      }
      if (!tab || !Number.isInteger(tab.id) || !tab.url) {
        throw new Error("Немає доступної активної вкладки. Відкрийте звичайну сторінку HTTP або HTTPS.");
      }

      tabId = tab.id;
      topUrl = tab.url;
      const context = await sendMessage({
        type: MESSAGE.GET_POPUP_CONTEXT,
        tabId
      });
      applyContext(context, true, true);
      await refreshCopiedSkipSettingsState();
      contextReady = true;
      setPopupState("ready");
      setStatus(context.exists ? "Профіль URL завантажено." : "Новий ключ: стандартно вимкнено.", false, "info");
      void refreshVideoAvailability();
      if (videoPollTimer === null) {
        videoPollTimer = setInterval(() => { void refreshVideoAvailability(); }, 2000);
      }
    } catch (error) {
      contextReady = false;
      tabId = null;
      topUrl = null;
      renderProfile(DEFAULT_PROFILE);
      elements.pageUrl.textContent = "URL недоступний";
      setPopupState("error", error.message);
    } finally {
      initializing = false;
      setBusy(!contextReady);
      renderFixerUi();
    }
  }

  async function saveProfile(successMessage = "Налаштування збережено.", profileOverride = null) {
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
        profile: profileOverride || readProfile()
      });
      applyContext(context);
      setStatus(successMessage);
    } catch (error) {
      if (profileOverride) {
        elements.enabled.checked = currentProfile.enabled === true;
      }
      setStatus(error.message, true);
    } finally {
      setBusy(false);
      renderPreview();
    }
  }

  async function getVideoState() {
    setBusy(true);
    setStatus("Шукаю активне відео…", false, "info");
    try {
      const result = await sendMessage({
        type: MESSAGE.COLLECT_VIDEO_STATE,
        tabId
      });
      if (!result.video) {
        videoAvailability = "missing";
        throw new Error("Відео в цій вкладці не знайдено.");
      }
      videoAvailability = "available";
      return result.video;
    } finally {
      setBusy(false);
    }
  }

  const advancedUi = AdvancedUi.create({
    sendMessage,
    getVideoState,
    setStatus,
    setBusy,
    getTabContext: () => ({ tabId, topUrl }),
    applyContext: (context, reset) => applyContext(context, true, reset),
    onClipboardChanged: refreshCopiedSkipSettingsState
  });

  async function setMode(mode) {
    if (mode === currentMode) return;
    if (advancedUi.hasUnsavedChanges() &&
        !confirm("Незбережені зміни серії буде скасовано. Перемкнути режим?")) {
      elements.modeSwitch.checked = currentMode === "advanced";
      return;
    }
    setBusy(true);
    try {
      const context = await sendMessage({
        type: MESSAGE.SET_ADVANCED_MODE,
        tabId,
        expectedUrl: topUrl,
        mode
      });
      applyContext(context, true, true);
      await refreshCopiedSkipSettingsState();
      setStatus(mode === "advanced" ? "Advanced Mode увімкнено." : "Easy Mode увімкнено.");
    } catch (error) {
      elements.modeSwitch.checked = currentMode === "advanced";
      setStatus(error.message, true);
    } finally {
      setBusy(false);
    }
  }

  elements.modeSwitch.addEventListener("change", () =>
    setMode(elements.modeSwitch.checked ? "advanced" : "easy")
  );

  elements.save.addEventListener("click", () => saveProfile());
  elements.enabled.addEventListener("change", () => {
    return saveProfile(elements.enabled.checked
      ? "OpEndSkipper увімкнено для цього URL."
      : "OpEndSkipper вимкнено для цього URL.", {
        ...currentProfile,
        enabled: elements.enabled.checked
      });
  });

  elements.copySkipSettings.addEventListener("click", async () => {
    setBusy(true);
    setStatus("");
    try {
      const current = readProfile();
      await sendMessage({
        type: MESSAGE.COPY_SKIP_SETTINGS,
        settings: {
          skipStart: current.skipStart,
          skipEnd: current.skipEnd
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
      applyContext(context);
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
      renderPreview();
    }
  });

  elements.useCurrentStart.addEventListener("click", async () => {
    try {
      const video = await getVideoState();
      renderTimeField("skipStart", video.currentTime);
      setStatus("Початок взято з активного відео. Натисніть «Зберегти».");
    } catch (error) {
      setStatus(error.message, true);
    }
  });

  elements.useCurrentEnd.addEventListener("click", async () => {
    try {
      const video = await getVideoState();
      if (!Time.isFiniteMediaTime(video.duration)) {
        throw new Error("Тривалість активного відео ще невідома.");
      }
      renderTimeField("skipEnd", Math.max(0, video.duration - video.currentTime));
      setStatus("Залишок взято з активного відео. Натисніть «Зберегти».");
    } catch (error) {
      setStatus(error.message, true);
    }
  });

  elements.enableAllFixers.addEventListener("click", () => setAllRules(true));
  elements.disableAllFixers.addEventListener("click", () => setAllRules(false));
  elements.addUrlFixer.addEventListener("click", startAdding);

  loadContext();
})();
