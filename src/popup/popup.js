(function initializePopup() {
  "use strict";

  const {
    DEFAULT_PROFILE,
    MESSAGE,
    UrlFixers
  } = globalThis.OpenDSkipper;

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
    status: document.getElementById("status"),
    urlFixerControls: document.getElementById("urlFixerControls"),
    enableAllFixers: document.getElementById("enableAllFixers"),
    disableAllFixers: document.getElementById("disableAllFixers"),
    urlFixerList: document.getElementById("urlFixerList"),
    addFixerForm: document.getElementById("addFixerForm"),
    addUrlFixer: document.getElementById("addUrlFixer"),
    previewOriginalUrl: document.getElementById("previewOriginalUrl"),
    previewProfileKey: document.getElementById("previewProfileKey"),
    urlFixerWarning: document.getElementById("urlFixerWarning")
  };

  let tabId = null;
  let topUrl = null;
  let profileKey = null;
  let urlFixerWarning = null;
  let urlFixerSettings = { schemaVersion: 1, rules: [] };
  let initializing = true;
  let contextReady = false;
  let busy = false;
  let hasCopiedSkipSettings = false;
  let editorState = null;
  let pendingDeleteId = null;

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

  function setStatus(text, isError = false) {
    elements.status.textContent = text;
    elements.status.classList.toggle("error", isError);
  }

  function updateFixerActionStates() {
    const rulesUnavailable =
      urlFixerSettings.rules.length === 0 ||
      editorState !== null ||
      pendingDeleteId !== null;
    elements.enableAllFixers.disabled = rulesUnavailable;
    elements.disableAllFixers.disabled = rulesUnavailable;
    elements.addUrlFixer.disabled =
      editorState !== null ||
      pendingDeleteId !== null ||
      urlFixerSettings.rules.length >= UrlFixers.MAX_RULES;
  }

  function setBusy(nextBusy) {
    busy = nextBusy;
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
    elements.urlFixerControls.disabled = busy || !contextReady;
    updateFixerActionStates();
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

  function applyContext(context, includeFixerSettings = false) {
    topUrl = context.topUrl;
    profileKey = context.profileKey;
    urlFixerWarning = context.urlFixerWarning || null;
    elements.pageUrl.textContent = topUrl;
    elements.pageUrl.title = topUrl;
    renderProfile(context.profile);

    if (includeFixerSettings && context.urlFixerSettings) {
      urlFixerSettings = context.urlFixerSettings;
    }
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
    elements.urlFixerWarning.textContent = warning || "";
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
    const error = document.createElement("p");
    error.className = "field-error";
    error.textContent = editorState.errors[errorKey] || "";
    control.addEventListener("input", () => {
      editorState.errors[errorKey] = "";
      error.textContent = "";
    });
    wrapper.append(label, error);
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
      applyContext(context, true);
      contextReady = true;
      await refreshCopiedSkipSettingsState();
      setStatus(context.exists ? "Профіль URL завантажено." : "Новий ключ: стандартно вимкнено.");
    } catch (error) {
      renderProfile(DEFAULT_PROFILE);
      elements.pageUrl.textContent = "URL недоступний";
      setStatus(error.message, true);
    } finally {
      initializing = false;
      setBusy(!contextReady);
      renderFixerUi();
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
      applyContext(context);
      setStatus(successMessage);
    } catch (error) {
      setStatus(error.message, true);
    } finally {
      setBusy(false);
      renderPreview();
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
      elements.skipEnd.value = Math.max(0, Math.floor(video.duration - video.currentTime));
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

  elements.enableAllFixers.addEventListener("click", () => setAllRules(true));
  elements.disableAllFixers.addEventListener("click", () => setAllRules(false));
  elements.addUrlFixer.addEventListener("click", startAdding);

  loadContext();
})();
