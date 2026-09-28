(function initializeAdvancedUi(root) {
  "use strict";

  const { Advanced, EpisodeDetector, MESSAGE, StringTransforms, Time, TimeField } = root.OpenDSkipper;
  const TEMPLATES_OPEN_KEY = "popupTemplatesOpen:v1";
  const DETECTOR_OPEN_KEY = "popupEpisodeDetectorOpen:v1";
  const EDIT_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L8 18l-4 1 1-4Z"/></svg>';
  const DELETE_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 6h18M8 6V4h8v2m3 0-1 14H6L5 6m5 4v7m4-7v7"/></svg>';

  function create({
    sendMessage, getVideoState, setStatus, setBusy, getTabContext,
    applyContext, onClipboardChanged = async () => {}
  }) {
    const ids = [
      "advancedSection", "advancedCurrentEpisode", "detectorType", "detectorPlayerFields",
      "detectorSource", "detectorCandidates", "detectorTopFields", "detectorTopUrl",
      "detectorTransforms", "addDetectorTransform", "detectorSelectedSource",
      "detectorRawSource", "detectorEpisodePreview", "advancedRangeList",
      "addAdvancedRange", "advancedEditor", "advancedEditorTitle", "advancedStart",
      "advancedStartFraction", "advancedEnd", "advancedEndFraction",
      "advancedCurrentStart", "advancedCurrentEnd", "quickZeroCurrent",
      "quickZeroNinety", "quickCurrentNinety", "quickCurrentEnd",
      "advancedTemplates", "advancedTemplatesSummary",
      "advancedDetector", "advancedDetectorSummary",
      "cancelAdvancedEdit", "applyAdvancedEdit", "copyAdvancedRanges",
      "pasteAdvancedRanges", "cancelAdvancedRanges", "saveAdvancedRanges"
    ];
    const el = Object.fromEntries(ids.map((id) => [id, document.getElementById(id)]));
    const startField = TimeField.create(el.advancedStart, el.advancedStartFraction);
    const endField = TimeField.create(el.advancedEnd, el.advancedEndFraction);
    let saved = [];
    let draft = [];
    let episodeId = null;
    let profileKey = null;
    let detectorDraft = null;
    let detectorContext = null;
    let detectorEditPending = false;
    let detectorTimer = null;
    let detectorRevision = 0;
    let detectorSaveChain = Promise.resolve();
    let editIndex = null;
    let dirty = false;
    let detectorConfigured = false;

    function bindOpenPreference(details, summary, key, forceOpen = () => false, saveAnyToggle = false) {
      let touched = false;
      let loaded = false;
      let preferredOpen = true;
      const refresh = () => { details.open = forceOpen() || preferredOpen; };
      summary.addEventListener("click", () => { touched = true; });
      summary.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") touched = true;
      });
      chrome.storage.local.get(key).then((stored) => {
        loaded = true;
        if (!touched) {
          preferredOpen = stored[key] !== false;
          refresh();
        } else if (!forceOpen()) {
          preferredOpen = details.open;
          chrome.storage.local.set({ [key]: preferredOpen }).catch(() => {});
        }
      }).catch(() => { loaded = true; });
      details.addEventListener("toggle", () => {
        if (forceOpen()) {
          touched = false;
          refresh();
        } else if (loaded && (touched || saveAnyToggle)) {
          touched = false;
          preferredOpen = details.open;
          chrome.storage.local.set({ [key]: preferredOpen }).catch(() => {});
        }
      });
      return refresh;
    }

    bindOpenPreference(el.advancedTemplates, el.advancedTemplatesSummary, TEMPLATES_OPEN_KEY,
      () => false, true);
    const refreshDetectorOpen = bindOpenPreference(
      el.advancedDetector, el.advancedDetectorSummary, DETECTOR_OPEN_KEY,
      () => !detectorConfigured
    );

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
      el.saveAdvancedRanges.disabled = !episodeId || !dirty;
      el.cancelAdvancedRanges.disabled = !episodeId || !dirty;
      el.addAdvancedRange.disabled = !episodeId;
      el.copyAdvancedRanges.disabled = !episodeId;
      el.pasteAdvancedRanges.disabled = !episodeId;
    }

    function render(context, reset = false) {
      const advanced = context.advanced || { mode: "easy", currentEpisode: null, ranges: [] };
      if (!detectorEditPending || context.profileKey !== profileKey) {
        detectorDraft = EpisodeDetector.normalizeConfig(advanced.episodeDetector);
      }
      detectorConfigured = Boolean(EpisodeDetector.normalizeConfig(advanced.episodeDetector));
      refreshDetectorOpen();
      detectorContext = context;
      if (reset || context.profileKey !== profileKey || advanced.currentEpisode !== episodeId) {
        profileKey = context.profileKey;
        episodeId = advanced.currentEpisode;
        saved = cloneRanges(advanced.ranges);
        draft = cloneRanges(saved);
        dirty = false;
        closeEditor();
      }
      el.advancedCurrentEpisode.textContent = episodeId || "Не визначено";
      renderDetector();
      renderList();
    }

    function selectedRaw() {
      if (!detectorDraft) return null;
      if (detectorDraft.type === "top-url") return detectorContext.topUrl;
      return detectorContext.episodeCandidates?.find((candidate) =>
        candidate.source === detectorDraft.source)?.value || null;
    }

    function renderDetectorPreview() {
      const detected = EpisodeDetector.detectEpisode(detectorDraft, {
        topUrl: detectorContext.topUrl,
        candidates: detectorContext.episodeCandidates || []
      });
      const source = detectorDraft
        ? (detectorDraft.type === "player-url" ? detectorDraft.source : "top-url") : null;
      el.detectorSelectedSource.textContent = source || "—";
      el.detectorRawSource.textContent = selectedRaw() || "Недоступне";
      el.detectorEpisodePreview.textContent = detected?.id || "Не визначено";
    }

    async function saveDetector() {
      detectorTimer = null;
      const revision = detectorRevision;
      const value = EpisodeDetector.normalizeConfig(detectorDraft);
      if (detectorDraft && !value) return;
      try {
        detectorSaveChain = detectorSaveChain.catch(() => {}).then(() =>
          sendMessage(getMessage(MESSAGE.SET_EPISODE_DETECTOR, { detector: value }))
        );
        const context = await detectorSaveChain;
        if (revision !== detectorRevision) return;
        detectorEditPending = false;
        applyContext(context, false);
      } catch (error) {
        setStatus(error.message, true);
      }
    }

    function queueDetectorSave(delay = 0) {
      detectorEditPending = true;
      detectorRevision++;
      if (detectorTimer !== null) clearTimeout(detectorTimer);
      detectorTimer = setTimeout(saveDetector, delay);
      renderDetectorPreview();
    }

    function makeOption(value, label) {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = label;
      return option;
    }

    function renderDetector() {
      el.detectorType.value = detectorDraft?.type || "";
      el.detectorPlayerFields.hidden = detectorDraft?.type !== "player-url";
      el.detectorTopFields.hidden = detectorDraft?.type !== "top-url";
      el.detectorTopUrl.textContent = detectorContext.topUrl || "—";
      const candidates = detectorContext.episodeCandidates || [];
      el.detectorCandidates.replaceChildren();
      for (const candidate of candidates) {
        const item = document.createElement("li");
        item.textContent = `${candidate.source}: ${candidate.value}`;
        el.detectorCandidates.append(item);
      }
      if (!candidates.length) {
        const item = document.createElement("li");
        item.textContent = "Джерел поки немає.";
        el.detectorCandidates.append(item);
      }
      el.detectorSource.replaceChildren(makeOption("", "Оберіть source type"));
      const sources = [...new Set(candidates.map((candidate) => candidate.source))];
      if (detectorDraft?.source && !sources.includes(detectorDraft.source)) {
        el.detectorSource.append(makeOption(detectorDraft.source, `${detectorDraft.source} (недоступне)`));
      }
      for (const source of sources) {
        const candidate = candidates.find((item) => item.source === source);
        el.detectorSource.append(makeOption(source, `${source}: ${candidate.value}`));
      }
      el.detectorSource.value = detectorDraft?.source || "";
      el.detectorSource.disabled = sources.length === 0;
      el.detectorTransforms.replaceChildren();
      for (const [index, step] of (detectorDraft?.transforms || []).entries()) {
        const row = document.createElement("div");
        row.className = "detector-transform";
        const fields = document.createElement("div");
        fields.className = "detector-transform-fields";
        const type = document.createElement("select");
        for (const [key, label] of [
          ["truncateAfter", "Відкинути після"], ["truncateAfterLast", "Відкинути після останнього"],
          ["removeExact", "Видалити точний текст"], ["replaceExact", "Замінити точний текст"],
          ["takeAfterFirst", "Взяти після першого"], ["takeAfterLast", "Взяти після останнього"],
          ["lastNonEmptyPart", "Остання непорожня частина"], ["queryParameter", "Query parameter"]
        ]) type.append(makeOption(key, label));
        type.value = step.type;
        type.addEventListener("change", () => { step.type = type.value; queueDetectorSave(); renderDetector(); });
        fields.append(type);
        const value = document.createElement("input");
        value.type = "text";
        value.value = step.value;
        value.placeholder = step.type === "queryParameter" ? "parameter" : "separator / text";
        value.addEventListener("input", () => { step.value = value.value; queueDetectorSave(300); });
        value.addEventListener("change", () => queueDetectorSave());
        fields.append(value);
        if (step.type === "removeExact" || step.type === "replaceExact") {
          const position = document.createElement("select");
          for (const key of ["anywhere", "start", "end"]) position.append(makeOption(key, key));
          position.value = step.position || "anywhere";
          position.addEventListener("change", () => { step.position = position.value; queueDetectorSave(); });
          fields.append(position);
        }
        if (step.type === "replaceExact") {
          const replacement = document.createElement("input");
          replacement.type = "text";
          replacement.placeholder = "Заміна";
          replacement.value = step.replacement || "";
          replacement.addEventListener("input", () => { step.replacement = replacement.value; queueDetectorSave(300); });
          replacement.addEventListener("change", () => queueDetectorSave());
          fields.append(replacement);
        }
        const remove = document.createElement("button");
        remove.type = "button";
        remove.className = "secondary compact";
        remove.textContent = "×";
        remove.title = "Видалити transform";
        remove.setAttribute("aria-label", remove.title);
        remove.addEventListener("click", () => {
          detectorDraft.transforms.splice(index, 1);
          queueDetectorSave(); renderDetector();
        });
        row.append(fields, remove);
        el.detectorTransforms.append(row);
      }
      el.addDetectorTransform.disabled = !detectorDraft;
      renderDetectorPreview();
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
        await sendMessage(getMessage(MESSAGE.COPY_ADVANCED_RANGES));
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

    el.detectorType.addEventListener("change", () => {
      const type = el.detectorType.value;
      detectorDraft = type === "top-url" ? { type, transforms: [] }
        : type === "player-url" ? { type, source: "", transforms: [] } : null;
      renderDetector();
      queueDetectorSave();
    });
    el.detectorSource.addEventListener("change", () => {
      detectorDraft.source = el.detectorSource.value;
      queueDetectorSave();
      renderDetector();
    });
    el.addDetectorTransform.addEventListener("click", () => {
      if (!detectorDraft) return;
      detectorDraft.transforms.push({ type: StringTransforms.TYPE.LAST_NON_EMPTY_PART, value: "/" });
      queueDetectorSave();
      renderDetector();
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
