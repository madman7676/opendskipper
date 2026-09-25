(function initializeAdvancedUi(root) {
  "use strict";

  const { Advanced, MESSAGE, Time, TimeField } = root.OpenDSkipper;
  const TEMPLATES_OPEN_KEY = "popupTemplatesOpen:v1";
  const EDIT_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L8 18l-4 1 1-4Z"/></svg>';
  const DELETE_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 6h18M8 6V4h8v2m3 0-1 14H6L5 6m5 4v7m4-7v7"/></svg>';

  function create({
    sendMessage, getVideoState, setStatus, setBusy, getTabContext,
    applyContext, onClipboardChanged = async () => {}
  }) {
    const ids = [
      "advancedSection", "advancedEpisode", "selectAdvancedEpisode", "advancedRangeList",
      "addAdvancedRange", "advancedEditor", "advancedEditorTitle", "advancedStart",
      "advancedStartFraction", "advancedEnd", "advancedEndFraction",
      "advancedCurrentStart", "advancedCurrentEnd", "quickZeroCurrent",
      "quickZeroNinety", "quickCurrentNinety", "quickCurrentEnd",
      "advancedTemplates", "advancedTemplatesSummary",
      "cancelAdvancedEdit", "applyAdvancedEdit", "copyAdvancedRanges",
      "pasteAdvancedRanges", "cancelAdvancedRanges", "saveAdvancedRanges"
    ];
    const el = Object.fromEntries(ids.map((id) => [id, document.getElementById(id)]));
    const startField = TimeField.create(el.advancedStart, el.advancedStartFraction);
    const endField = TimeField.create(el.advancedEnd, el.advancedEndFraction);
    let saved = [];
    let draft = [];
    let episodeId = "1";
    let profileKey = null;
    let editIndex = null;
    let dirty = false;
    let templatesTouched = false;
    let templatesPreferenceLoaded = false;

    el.advancedTemplatesSummary.addEventListener("click", () => { templatesTouched = true; });
    el.advancedTemplatesSummary.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") templatesTouched = true;
    });
    chrome.storage.local.get(TEMPLATES_OPEN_KEY).then((stored) => {
      templatesPreferenceLoaded = true;
      if (!templatesTouched) {
        el.advancedTemplates.open = stored[TEMPLATES_OPEN_KEY] !== false;
      } else {
        chrome.storage.local.set({ [TEMPLATES_OPEN_KEY]: el.advancedTemplates.open }).catch(() => {});
      }
    }).catch(() => { templatesPreferenceLoaded = true; });
    el.advancedTemplates.addEventListener("toggle", () => {
      if (templatesPreferenceLoaded) {
        chrome.storage.local.set({ [TEMPLATES_OPEN_KEY]: el.advancedTemplates.open }).catch(() => {});
      }
    });

    function cloneRanges(ranges) {
      return ranges.map(({ key, start, end }) => ({ key, start, end }));
    }

    function renderList() {
      el.advancedRangeList.replaceChildren();
      const sorted = Advanced.sortRanges(draft.map((range, index) => ({ ...range, index })));
      if (!sorted.length) {
        const empty = document.createElement("li");
        empty.className = "empty-rules";
        empty.textContent = "Діапазонів поки немає.";
        el.advancedRangeList.append(empty);
      }
      for (const range of sorted) {
        const row = document.createElement("li");
        row.className = "advanced-range";
        const label = document.createElement("span");
        label.className = "advanced-range-time";
        label.textContent = `${TimeField.format(range.start).replace(" .", ".")} → ${TimeField.format(range.end).replace(" .", ".")}`;
        row.append(label);
        const actions = document.createElement("div");
        actions.className = "advanced-range-actions";
        for (const [labelText, icon, className, action] of [
          ["Редагувати діапазон", EDIT_ICON, "range-icon range-edit", () => openEditor(range.index)],
          ["Видалити діапазон", DELETE_ICON, "range-icon range-delete", () => {
            draft.splice(range.index, 1);
            dirty = true;
            closeEditor();
            renderList();
            setStatus("Видалено з чернетки. Натисніть «Зберегти набір».");
          }]
        ]) {
          const button = document.createElement("button");
          button.type = "button";
          button.className = className;
          button.title = labelText;
          button.setAttribute("aria-label", labelText);
          button.innerHTML = icon;
          button.addEventListener("click", action);
          actions.append(button);
        }
        row.append(actions);
        el.advancedRangeList.append(row);
      }
      el.saveAdvancedRanges.disabled = !dirty;
      el.cancelAdvancedRanges.disabled = !dirty;
    }

    function render(context, reset = false) {
      const advanced = context.advanced || { mode: "easy", currentEpisode: "1", ranges: [] };
      if (reset || context.profileKey !== profileKey || advanced.currentEpisode !== episodeId) {
        profileKey = context.profileKey;
        episodeId = advanced.currentEpisode;
        saved = cloneRanges(advanced.ranges);
        draft = cloneRanges(saved);
        dirty = false;
        closeEditor();
      }
      el.advancedEpisode.value = episodeId;
      renderList();
    }

    function closeEditor() {
      editIndex = null;
      el.advancedEditor.hidden = true;
    }

    function openEditor(index = null) {
      editIndex = index;
      const range = index === null ? { start: 0, end: 0 } : draft[index];
      startField.set(range.start);
      endField.set(range.end);
      el.advancedEditorTitle.textContent = index === null ? "Новий діапазон" : "Редагувати діапазон";
      el.applyAdvancedEdit.textContent = "Зберегти у чернетку";
      el.advancedEditor.hidden = false;
      el.advancedStart.focus();
    }

    function validCurrent(video) {
      if (!Time.isFiniteMediaTime(video.currentTime) || video.currentTime < 0) {
        throw new Error("Поточний час відео недоступний.");
      }
      return video.currentTime;
    }

    async function withVideo(action) {
      try {
        const video = await getVideoState();
        action(video);
        setStatus("Час узято з відео. Збережіть діапазон у чернетку, потім збережіть набір.");
      } catch (error) {
        setStatus(error.message, true);
      }
    }

    function getMessage(type, extra = {}) {
      const { tabId, topUrl } = getTabContext();
      return { type, tabId, expectedUrl: topUrl, ...extra };
    }

    async function copySaved() {
      setBusy(true);
      try {
        await sendMessage(getMessage(MESSAGE.COPY_ADVANCED_RANGES, {
          selectedKey: null
        }));
        await onClipboardChanged();
        setStatus("Збережений набір скопійовано.");
      } catch (error) {
        setStatus(error.message, true);
      } finally {
        setBusy(false);
      }
    }

    el.addAdvancedRange.addEventListener("click", () => openEditor());
    el.cancelAdvancedEdit.addEventListener("click", closeEditor);
    el.applyAdvancedEdit.addEventListener("click", () => {
      const start = startField.get();
      const end = endField.get();
      if (!Time.isFiniteMediaTime(start) || !Time.isFiniteMediaTime(end) ||
          start < 0 || end <= start || !Advanced.normalizeTiming(start, end)) {
        setStatus("Діапазон має містити start ≥ 0 та end > start; після округлення до 10 мс він має лишатися ненульовим.", true);
        return;
      }
      const key = Advanced.makeTimingKey(start, end);
      const duplicate = draft.findIndex((range, index) =>
        index !== editIndex && Advanced.makeTimingKey(range.start, range.end) === key
      );
      if (duplicate !== -1) {
        setStatus("Такий діапазон уже є в чернетці.", true);
        return;
      }
      const old = editIndex === null ? null : draft[editIndex];
      const next = { key: old && old.key === key ? old.key : null, start, end };
      if (editIndex === null) draft.push(next);
      else draft[editIndex] = next;
      dirty = true;
      closeEditor();
      renderList();
      setStatus("Чернетку оновлено. Натисніть «Зберегти набір».");
    });

    el.advancedCurrentStart.addEventListener("click", () => withVideo((video) => startField.set(validCurrent(video))));
    el.advancedCurrentEnd.addEventListener("click", () => withVideo((video) => endField.set(validCurrent(video))));
    el.quickZeroCurrent.addEventListener("click", () => withVideo((video) => {
      startField.set(0); endField.set(validCurrent(video));
    }));
    el.quickZeroNinety.addEventListener("click", () => {
      startField.set(0); endField.set(90);
    });
    el.quickCurrentNinety.addEventListener("click", () => withVideo((video) => {
      const current = validCurrent(video);
      startField.set(current); endField.set(current + 90);
    }));
    el.quickCurrentEnd.addEventListener("click", () => withVideo((video) => {
      const current = validCurrent(video);
      if (!Time.isFiniteMediaTime(video.duration) || video.duration <= current) {
        throw new Error("Кінець відео ще недоступний.");
      }
      startField.set(current); endField.set(video.duration);
    }));

    el.selectAdvancedEpisode.addEventListener("click", async () => {
      const next = el.advancedEpisode.value.trim();
      if (!next || next.length > 80) {
        setStatus("Введіть ідентифікатор серії (до 80 символів).", true);
        return;
      }
      if (next === episodeId) return;
      if (dirty && !confirm("Незбережені зміни серії буде скасовано. Відкрити іншу серію?")) {
        el.advancedEpisode.value = episodeId;
        return;
      }
      setBusy(true);
      try {
        const context = await sendMessage(getMessage(MESSAGE.SET_ADVANCED_EPISODE, { episodeId: next }));
        applyContext(context, true);
        setStatus(`Відкрито серію ${next}.`);
      } catch (error) {
        el.advancedEpisode.value = episodeId;
        setStatus(error.message, true);
      } finally {
        setBusy(false);
      }
    });
    el.advancedEpisode.addEventListener("keydown", (event) => {
      if (event.key === "Enter") el.selectAdvancedEpisode.click();
    });

    el.copyAdvancedRanges.addEventListener("click", () => copySaved());
    el.pasteAdvancedRanges.addEventListener("click", async () => {
      setBusy(true);
      try {
        const result = await sendMessage({ type: MESSAGE.GET_ADVANCED_CLIPBOARD });
        draft = cloneRanges(result.ranges);
        dirty = true;
        closeEditor();
        renderList();
        setStatus("Набір вставлено в чернетку. Натисніть «Зберегти набір».");
      } catch (error) {
        setStatus(error.message, true);
      } finally {
        setBusy(false);
      }
    });
    el.cancelAdvancedRanges.addEventListener("click", () => {
      draft = cloneRanges(saved);
      dirty = false;
      closeEditor();
      renderList();
      setStatus("Зміни чернетки скасовано.");
    });
    el.saveAdvancedRanges.addEventListener("click", async () => {
      setBusy(true);
      try {
        const ranges = draft.map((range) => range.key
          ? { key: range.key } : { start: range.start, end: range.end });
        const context = await sendMessage(getMessage(MESSAGE.SAVE_ADVANCED_RANGES, {
          episodeId, ranges
        }));
        applyContext(context, true);
        setStatus("Набір збережено.");
      } catch (error) {
        setStatus(error.message, true);
      } finally {
        setBusy(false);
      }
    });

    return Object.freeze({ render, hasUnsavedChanges: () => dirty });
  }

  root.OpenDSkipper.AdvancedUi = Object.freeze({ create });
})(globalThis);
