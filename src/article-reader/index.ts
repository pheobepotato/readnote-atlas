import {
  clearAnnotationMarkup,
  createAnnotationRecord,
  createExcerptFromAnnotation,
  normalizeAnnotationRecord,
  toggleAnnotationStyle
} from "../shared/annotations";
import { canonicalizeUrl, sourceIdFromUrl } from "../shared/ids";
import {
  deleteAnnotation,
  deleteAnnotations,
  listAnnotations,
  listTranslations,
  saveAnnotation,
  saveExcerpt,
  saveSource,
  saveTranslations
} from "../shared/storage";
import { runExtensionTask } from "../shared/extension-lifecycle";
import type { AnnotationRecord, AnnotationStyle, ExcerptRecord, SourceRecord, TranslationRecord } from "../shared/types";
import { computeToolbarPosition, type RectLike } from "./positioning";
import { annotationClassName, orderAnnotationsForRendering, type AnnotationClassOptions } from "./rendering";
import { getContextForText } from "./text";
import {
  createTranslationBatches,
  createTranslationRecord,
  isUsableTranslationText,
  translationBlockKey,
  uniqueTranslationBlocks,
  type TranslationBlock
} from "./translation";

const TOOLBAR_WIDTH = 312;
const TOOLBAR_HEIGHT = 34;
let currentSource: SourceRecord | null = null;
let toolbar: HTMLDivElement | null = null;
let noteEditor: HTMLDivElement | null = null;
let notePanel: HTMLDivElement | null = null;
let pendingSelectionText = "";
let pendingSelectionRect: RectLike | null = null;
let pendingNoteDraft: AnnotationRecord | null = null;
let pendingAnnotationId = "";
let suppressSelectionToolbarUntil = 0;

function readableText(): string {
  if (!document.body) {
    return "";
  }

  const clone = document.body.cloneNode(true) as HTMLElement;
  clone.querySelectorAll<HTMLElement>(".rk-annotation").forEach((annotation) => {
    annotation.replaceWith(document.createTextNode(annotation.textContent ?? ""));
  });
  clone
    .querySelectorAll(
      [
        ".rk-toolbar",
        ".rk-note-editor",
        ".rk-note-panel",
        ".rk-note-bubble",
        ".rk-toast",
        ".rk-translation",
        ".rk-page-actions",
        ".rk-translate-button"
      ].join(", ")
    )
    .forEach((element) => element.remove());
  return clone.innerText.trim();
}

function shouldSkipTextNode(node: Text): boolean {
  const parent = node.parentElement;
  if (!parent) {
    return true;
  }

  return Boolean(
    parent.closest(
      [
        "script",
        "style",
        "textarea",
        "input",
        "select",
        "option",
        ".rk-toolbar",
        ".rk-note-editor",
        ".rk-note-panel",
        ".rk-toast",
        ".rk-translation",
        ".rk-page-actions",
        ".rk-translate-button"
      ].join(", ")
    )
  );
}

function rectFromDomRect(rect: DOMRect): RectLike {
  return {
    left: rect.left,
    top: rect.top,
    right: rect.right,
    bottom: rect.bottom,
    width: rect.width,
    height: rect.height
  };
}

function finalSelectionRect(range: Range): RectLike | null {
  const rects = Array.from(range.getClientRects()).filter((rect) => rect.width > 0 && rect.height > 0);
  const rect = rects.at(-1) ?? range.getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0) {
    return null;
  }

  return rectFromDomRect(rect);
}

function removeToolbar(): void {
  toolbar?.remove();
  toolbar = null;
}

function removeNoteEditor(): void {
  noteEditor?.remove();
  noteEditor = null;
}

function removeNotePanel(): void {
  notePanel?.remove();
  notePanel = null;
}

function showToast(message: string): void {
  document.querySelector(".rk-toast")?.remove();
  const toast = document.createElement("div");
  toast.className = "rk-toast";
  toast.textContent = message;
  document.body.append(toast);
  window.setTimeout(() => toast.remove(), 1600);
}

function shouldRenderAnnotation(annotation: AnnotationRecord, options: AnnotationClassOptions = {}): boolean {
  const normalized = normalizeAnnotationRecord(annotation);
  return normalized.styles.length > 0 || normalized.note.trim().length > 0 || options.noteMark === true;
}

function appendNoteBubble(after: HTMLElement, annotation: AnnotationRecord): void {
  if (!annotation.note.trim()) {
    return;
  }

  const bubble = document.createElement("button");
  bubble.type = "button";
  bubble.className = "rk-note-bubble";
  bubble.textContent = "✎";
  bubble.title = annotation.note;
  bubble.addEventListener("click", () => {
    selectAnnotationElement(after, annotation);
    void showNotePanel(annotation, bubble.getBoundingClientRect());
  });
  after.after(bubble);
}

function selectAnnotationElement(element: HTMLElement, annotation: AnnotationRecord): void {
  const selection = window.getSelection();
  if (!selection) {
    return;
  }

  const range = document.createRange();
  range.selectNodeContents(element);
  selection.removeAllRanges();
  selection.addRange(range);
  pendingSelectionText = annotation.text;
  pendingSelectionRect = rectFromDomRect(element.getBoundingClientRect());
  pendingAnnotationId = annotation.id;
  suppressSelectionToolbarUntil = Date.now() + 250;
}

function wrapFirstTextMatch(annotation: AnnotationRecord, options: AnnotationClassOptions = {}): boolean {
  const normalized = normalizeAnnotationRecord(annotation);
  const renderOptions: AnnotationClassOptions = {
    ...options,
    noteMark: options.noteMark ?? normalized.note.trim().length > 0
  };
  if (!normalized.text.trim() || !shouldRenderAnnotation(normalized, renderOptions)) {
    return false;
  }

  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  let node = walker.nextNode() as Text | null;

  while (node) {
    if (!shouldSkipTextNode(node)) {
      const value = node.nodeValue ?? "";
      const index = value.indexOf(normalized.text);

      if (index !== -1) {
        const before = document.createTextNode(value.slice(0, index));
        const mark = document.createElement("span");
        mark.className = annotationClassName(normalized, renderOptions);
        mark.dataset.annotationId = normalized.id;
        mark.textContent = normalized.text;
        mark.addEventListener("click", (event) => {
          if (selectedText()) {
            return;
          }

          event.stopPropagation();
          selectAnnotationElement(mark, normalized);
          if (normalized.note.trim()) {
            void showNotePanel(normalized, mark.getBoundingClientRect());
            return;
          }

          showToolbarForSelection();
        });
        const after = document.createTextNode(value.slice(index + normalized.text.length));
        node.replaceWith(before, mark, after);
        appendNoteBubble(mark, normalized);
        return true;
      }
    }

    node = walker.nextNode() as Text | null;
  }

  return false;
}

function clearRenderedAnnotations(): void {
  document.querySelectorAll(".rk-note-bubble").forEach((bubble) => bubble.remove());
  document.querySelectorAll<HTMLElement>(".rk-annotation").forEach((annotation) => {
    annotation.replaceWith(document.createTextNode(annotation.textContent ?? ""));
  });
  document.body.normalize();
}

async function captureSource(): Promise<SourceRecord> {
  const now = new Date().toISOString();
  const url = canonicalizeUrl(location.href);
  const source: SourceRecord = {
    id: await sourceIdFromUrl(url),
    url,
    title: document.title || url,
    siteName: location.hostname,
    capturedText: "",
    firstReadAt: now,
    lastReadAt: now,
    tags: ["reading/source"]
  };

  return saveSource(source);
}

async function restoreAnnotations(sourceId: string): Promise<void> {
  clearRenderedAnnotations();
  const annotations = await listAnnotations(sourceId);
  const pendingId = pendingNoteDraft?.sourceId === sourceId ? pendingNoteDraft.id : "";
  if (pendingNoteDraft?.sourceId === sourceId && !annotations.some((annotation) => annotation.id === pendingNoteDraft?.id)) {
    annotations.push(pendingNoteDraft);
  }

  const ordered = orderAnnotationsForRendering(annotations);
  for (const annotation of ordered) {
    wrapFirstTextMatch(annotation, { noteMark: annotation.id === pendingId || annotation.note.trim().length > 0 });
  }
}

async function rerenderCurrentAnnotations(): Promise<void> {
  if (!currentSource) {
    return;
  }

  await restoreAnnotations(currentSource.id);
}

function selectedText(): string {
  return window.getSelection()?.toString().trim() ?? "";
}

function button(className: string, title: string, content: HTMLElement | string): HTMLButtonElement {
  const control = document.createElement("button");
  control.type = "button";
  control.className = className;
  control.title = title;
  if (typeof content === "string") {
    control.textContent = content;
  } else {
    control.append(content);
  }
  return control;
}

function colorDot(style: "yellow" | "blue" | "pink"): HTMLSpanElement {
  const dot = document.createElement("span");
  dot.className = `rk-dot rk-dot-${style}`;
  return dot;
}

function eraserIcon(): HTMLSpanElement {
  const icon = document.createElement("span");
  icon.className = "rk-eraser-icon";
  return icon;
}

function wavyIcon(): HTMLSpanElement {
  const icon = document.createElement("span");
  icon.className = "rk-wavy-icon";
  icon.textContent = "U";
  return icon;
}

function divider(): HTMLSpanElement {
  const item = document.createElement("span");
  item.className = "rk-divider";
  return item;
}

function placeFloatingElement(element: HTMLElement, rect: RectLike, size: { width: number; height: number }): void {
  const position = computeToolbarPosition({
    selectionEndRect: rect,
    toolbarSize: size,
    viewportSize: { width: window.innerWidth, height: window.innerHeight },
    gap: 8
  });

  element.style.left = `${position.left + window.scrollX}px`;
  element.style.top = `${position.top + window.scrollY}px`;
}

function showToolbarForSelection(): void {
  removeToolbar();
  removeNoteEditor();
  removeNotePanel();

  const selection = window.getSelection();
  const text = selectedText();
  if (!selection || selection.rangeCount === 0 || text.length === 0) {
    discardPendingNoteDraft();
    pendingSelectionText = "";
    pendingSelectionRect = null;
    pendingAnnotationId = "";
    return;
  }

  const rect = finalSelectionRect(selection.getRangeAt(0));
  if (!rect) {
    return;
  }

  const isAnnotationClickSelection = Boolean(
    pendingAnnotationId && Date.now() < suppressSelectionToolbarUntil && text === pendingSelectionText
  );
  if (!isAnnotationClickSelection) {
    pendingAnnotationId = "";
  }
  pendingSelectionText = text;
  pendingSelectionRect = rect;
  toolbar = document.createElement("div");
  toolbar.className = "rk-toolbar";
  toolbar.addEventListener("mousedown", (event) => {
    event.preventDefault();
  });

  for (const style of ["yellow", "blue", "pink"] as const) {
    const control = button("rk-tool", style, colorDot(style));
    control.addEventListener("click", () => {
      runExtensionTask(() => toggleStyleForSelection(style));
    });
    toolbar.append(control);
  }

  toolbar.append(divider());

  const underline = button("rk-tool", "Underline", "U");
  underline.classList.add("rk-underline-tool");
  underline.addEventListener("click", () => {
    runExtensionTask(() => toggleStyleForSelection("underline"));
  });
  toolbar.append(underline);

  const wavy = button("rk-tool rk-wavy-tool", "Wavy underline", wavyIcon());
  wavy.addEventListener("click", () => {
    runExtensionTask(() => toggleStyleForSelection("wavy"));
  });
  toolbar.append(wavy, divider());

  const note = button("rk-tool rk-pen-tool", "Note", "✎");
  note.addEventListener("click", () => {
    if (pendingSelectionRect) {
      runExtensionTask(() => showNoteEditor(null, pendingSelectionRect as RectLike));
    }
  });
  toolbar.append(note);

  const clear = button("rk-tool rk-clear-tool", "Clear selected", eraserIcon());
  clear.addEventListener("click", () => {
    runExtensionTask(clearAnnotationForSelection);
  });
  toolbar.append(clear);

  const save = button("rk-save-tool", "Save excerpt", "Save");
  save.addEventListener("click", () => {
    runExtensionTask(saveExcerptFromSelection);
  });
  toolbar.append(save);

  document.body.append(toolbar);
  placeFloatingElement(toolbar, rect, { width: TOOLBAR_WIDTH, height: TOOLBAR_HEIGHT });
}

async function buildAnnotation(styles: AnnotationStyle[] = [], note = ""): Promise<AnnotationRecord | null> {
  if (!currentSource || !pendingSelectionText) {
    return null;
  }

  const now = new Date().toISOString();
  const context = getContextForText(readableText(), pendingSelectionText);
  return createAnnotationRecord({
    sourceId: currentSource.id,
    text: pendingSelectionText,
    prefix: context.prefix,
    suffix: context.suffix,
    styles,
    note,
    createdAt: now
  });
}

async function findStoredAnnotation(draft: AnnotationRecord): Promise<AnnotationRecord | null> {
  const annotations = await listAnnotations(draft.sourceId);
  if (pendingAnnotationId) {
    const selected = annotations.find((annotation) => annotation.id === pendingAnnotationId);
    if (selected) {
      return selected;
    }
  }

  return annotations.find((annotation) => annotation.id === draft.id) ?? null;
}

async function saveOrDeleteAnnotation(annotation: AnnotationRecord): Promise<AnnotationRecord | null> {
  const normalized = normalizeAnnotationRecord(annotation);
  if (normalized.styles.length === 0 && !normalized.note.trim() && !normalized.savedAsExcerpt) {
    await deleteAnnotation(normalized.sourceId, normalized.id);
    return null;
  }

  return saveAnnotation(normalized);
}

function resetPendingSelection(): void {
  window.getSelection()?.removeAllRanges();
  pendingSelectionText = "";
  pendingSelectionRect = null;
  pendingNoteDraft = null;
  pendingAnnotationId = "";
  removeToolbar();
  removeNoteEditor();
  removeNotePanel();
}

async function toggleStyleForSelection(style: AnnotationStyle): Promise<AnnotationRecord | null> {
  const draft = await buildAnnotation();
  if (!draft) {
    return null;
  }

  const existing = await findStoredAnnotation(draft);
  const next = toggleAnnotationStyle(existing ?? draft, style);
  const saved = await saveOrDeleteAnnotation(next);
  await rerenderCurrentAnnotations();
  resetPendingSelection();
  return saved;
}

async function clearAnnotationForSelection(): Promise<void> {
  const draft = await buildAnnotation();
  if (!draft) {
    return;
  }

  const existing = await findStoredAnnotation(draft);
  if (existing) {
    await saveOrDeleteAnnotation(clearAnnotationMarkup(existing));
    await rerenderCurrentAnnotations();
    showToast("Cleared");
  }
  resetPendingSelection();
}

async function clearAllAnnotationsForCurrentPage(): Promise<void> {
  if (!currentSource) {
    return;
  }

  await deleteAnnotations(currentSource.id);
  clearRenderedAnnotations();
  resetPendingSelection();
  showToast("Cleared");
}

function discardPendingNoteDraft(): void {
  if (!pendingNoteDraft) {
    return;
  }

  pendingNoteDraft = null;
  runExtensionTask(rerenderCurrentAnnotations);
}

async function deleteNoteFromAnnotation(annotation: AnnotationRecord): Promise<void> {
  const annotations = await listAnnotations(annotation.sourceId);
  const existing = annotations.find((item) => item.id === annotation.id) ?? annotation;
  await saveOrDeleteAnnotation({
    ...existing,
    note: "",
    updatedAt: new Date().toISOString()
  });
  removeNotePanel();
  await rerenderCurrentAnnotations();
  resetPendingSelection();
  showToast("Note deleted");
}

function showNotePanel(annotation: AnnotationRecord, rect: RectLike | DOMRect): void {
  removeToolbar();
  removeNoteEditor();
  removeNotePanel();

  const normalized = normalizeAnnotationRecord(annotation);
  const normalizedRect = "toJSON" in rect ? rectFromDomRect(rect as DOMRect) : (rect as RectLike);

  notePanel = document.createElement("div");
  notePanel.className = "rk-note-panel";

  const noteText = document.createElement("div");
  noteText.className = "rk-note-panel-text";
  noteText.textContent = normalized.note.trim() || "No note";

  const actions = document.createElement("div");
  actions.className = "rk-note-panel-actions";

  const edit = button("rk-note-panel-button", "Edit note", "✎");
  edit.addEventListener("click", () => {
    runExtensionTask(() => showNoteEditor(normalized, normalizedRect));
  });

  const remove = button("rk-note-panel-button rk-note-panel-delete", "Delete note", "⌫");
  remove.addEventListener("click", () => {
    runExtensionTask(() => deleteNoteFromAnnotation(normalized));
  });

  actions.append(edit, remove);
  notePanel.append(noteText, actions);
  document.body.append(notePanel);
  placeFloatingElement(notePanel, normalizedRect, {
    width: notePanel.offsetWidth || 260,
    height: notePanel.offsetHeight || 92
  });
}

async function showNoteEditor(annotation: AnnotationRecord | null, rect: RectLike | DOMRect): Promise<void> {
  removeNoteEditor();
  removeNotePanel();
  const normalizedRect = "toJSON" in rect ? rectFromDomRect(rect as DOMRect) : (rect as RectLike);
  const draft = annotation ?? (await buildAnnotation());
  if (!annotation && draft) {
    pendingNoteDraft = draft;
    await rerenderCurrentAnnotations();
  }

  noteEditor = document.createElement("div");
  noteEditor.className = "rk-note-editor";
  const textarea = document.createElement("textarea");
  textarea.placeholder = "Note";
  textarea.value = draft?.note ?? "";
  const done = document.createElement("button");
  done.type = "button";
  done.textContent = "Done";
  done.addEventListener("click", () => {
    runExtensionTask(async () => {
      if (draft) {
        const existing = await findStoredAnnotation(draft);
        await saveOrDeleteAnnotation({
          ...(existing ?? draft),
          note: textarea.value,
          updatedAt: new Date().toISOString()
        });
      } else {
        const nextDraft = await buildAnnotation([], textarea.value);
        if (nextDraft) {
          const existing = await findStoredAnnotation(nextDraft);
          await saveOrDeleteAnnotation({
            ...(existing ?? nextDraft),
            note: textarea.value,
            updatedAt: new Date().toISOString()
          });
        }
      }
      pendingNoteDraft = null;
      await rerenderCurrentAnnotations();
      resetPendingSelection();
    });
  });

  noteEditor.append(textarea, done);
  document.body.append(noteEditor);
  placeFloatingElement(noteEditor, normalizedRect, { width: 220, height: 132 });
  textarea.focus();
}

type ExcerptSyncStatus = "synced" | "obsidian_only" | "saved";

async function syncExcerpt(excerpt: ExcerptRecord): Promise<ExcerptSyncStatus> {
  try {
    const data = (await chrome.runtime.sendMessage({
      action: "syncArticleExcerpt",
      excerpt
    })) as {
      success?: boolean;
      obsidian?: string;
      notion?: string;
    };
    if (!data.success) {
      return "saved";
    }
    if (data.notion === "synced") {
      return "synced";
    }
    return data.obsidian === "synced" ? "obsidian_only" : "saved";
  } catch {
    return "saved";
  }
}

async function saveExcerptFromSelection(): Promise<void> {
  const draft = await buildAnnotation();
  if (!draft || !currentSource) {
    return;
  }

  const existing = await findStoredAnnotation(draft);
  const annotation = await saveOrDeleteAnnotation({
    ...(existing ?? draft),
    savedAsExcerpt: true,
    updatedAt: new Date().toISOString()
  });
  if (!annotation) {
    return;
  }

  const excerpt = createExcerptFromAnnotation(annotation, {
    title: currentSource.title,
    url: currentSource.url
  });
  await saveExcerpt(excerpt);
  const syncStatus = await syncExcerpt(excerpt);
  showToast(syncStatus === "synced" ? "Synced" : syncStatus === "obsidian_only" ? "Obsidian synced" : "Saved");
  resetPendingSelection();
}

function translationElement(element: HTMLElement): HTMLElement | null {
  const candidate = element.matches("li")
    ? element.querySelector<HTMLElement>(":scope > .rk-translation")
    : element.nextElementSibling;
  return candidate?.classList.contains("rk-translation") ? candidate as HTMLElement : null;
}

function ensureTranslationElement(element: HTMLElement): HTMLElement {
  const existing = translationElement(element);
  if (existing) {
    return existing;
  }

  const translation = document.createElement("span");
  translation.className = "rk-translation";
  if (element.matches("li")) {
    // Keep valid list markup and put the parent's translation before its sublist.
    element.insertBefore(translation, element.querySelector(":scope > ul, :scope > ol"));
  } else {
    element.after(translation);
  }
  return translation;
}

function insertTranslationAfter(element: HTMLElement, text: string): void {
  const translation = ensureTranslationElement(element);
  translation.textContent = text;
  translation.classList.remove("rk-translation-pending", "rk-translation-error");
}

function markTranslationPending(element: HTMLElement): void {
  const translation = ensureTranslationElement(element);
  translation.classList.remove("rk-translation-error");
  translation.classList.add("rk-translation-pending");
  translation.textContent = "Translating...";
}

function markTranslationError(element: HTMLElement): void {
  const translation = translationElement(element);
  if (!translation) {
    return;
  }
  translation.classList.remove("rk-translation-pending");
  translation.classList.add("rk-translation-error");
  translation.textContent = "Translation paused. Tap Translate to retry.";
}

function translationSourceText(element: HTMLElement): string {
  if (!element.matches("li")) {
    return element.innerText.trim();
  }

  const clone = element.cloneNode(true) as HTMLElement;
  // Each nested item is collected separately; generated translations are never source text.
  clone.querySelectorAll("ul, ol, .rk-translation").forEach((child) => child.remove());
  return (clone.textContent ?? "").trim();
}

function isReadableBlock(element: HTMLElement): boolean {
  if (
    element.closest(
      [
        ".rk-toolbar",
        ".rk-note-editor",
        ".rk-note-panel",
        ".rk-toast",
        ".rk-translation",
        ".rk-page-actions",
        "nav",
        "footer",
        "header",
        "aside",
        "script",
        "style"
      ].join(", ")
    )
  ) {
    return false;
  }

  const text = translationSourceText(element);
  if (element.matches("h1, h2")) {
    return text.length >= 8;
  }

  return text.length >= 50;
}

function collectTranslationBlocks(sourceId: string): Array<TranslationBlock & { element: HTMLElement }> {
  return uniqueTranslationBlocks(
    Array.from(document.querySelectorAll<HTMLElement>("h1, h2, p, li"))
      // A list item owns its paragraphs, so nested paragraph markup cannot duplicate it.
      .filter((element) => element.matches("li") || !element.closest("li"))
      .filter(isReadableBlock)
      .map((element) => {
        const text = translationSourceText(element);
        return {
          element,
          key: translationBlockKey(sourceId, text),
          text
        };
      })
  );
}

async function requestTranslations(paragraphs: string[]): Promise<string[] | null> {
  try {
    const data = (await chrome.runtime.sendMessage({
      action: "translateArticle",
      payload: {
        source: {
          title: document.title,
          url: canonicalizeUrl(location.href)
        },
        paragraphs
      }
    })) as { success?: boolean; translations?: string[] };
    if (!data.success) {
      return null;
    }
    return data.translations?.length === paragraphs.length ? data.translations : null;
  } catch {
    return null;
  }
}

async function translateBatchWithFallback(batch: Array<TranslationBlock & { element: HTMLElement }>): Promise<string[]> {
  const batchTranslations = await requestTranslations(batch.map((item) => item.text));
  if (batchTranslations) {
    return batchTranslations;
  }

  if (batch.length === 1) {
    return [];
  }

  const translations: string[] = [];
  for (const item of batch) {
    const [translation] = (await requestTranslations([item.text])) ?? [];
    translations.push(translation ?? "");
  }
  return translations;
}

async function translatePage(): Promise<void> {
  if (!currentSource) {
    currentSource = await captureSource();
  }

  const source = currentSource;
  const blocks = collectTranslationBlocks(source.id);
  if (blocks.length === 0) {
    showToast("Nothing to translate");
    return;
  }

  const cached = await listTranslations(source.id);
  const cachedByKey = new Map(
    cached.filter((translation) => isUsableTranslationText(translation.translation)).map((translation) => [
      translation.textHash,
      translation
    ])
  );
  const cachedKeys = new Set(cachedByKey.keys());
  const cachedBlockCount = blocks.filter((block) => cachedByKey.has(block.key)).length;

  for (const block of blocks) {
    const translation = cachedByKey.get(block.key)?.translation;
    if (translation) {
      insertTranslationAfter(block.element, translation);
    }
  }

  const batches = createTranslationBatches(blocks, cachedKeys, { firstBatchSize: 1, batchSize: 3 });
  if (batches.length === 0) {
    showToast("Translated");
    return;
  }

  showToast(cachedBlockCount > 0 ? "Continuing translation" : "Translating");
  let translatedCount = cachedBlockCount;
  for (const batch of batches) {
    batch.forEach((item) => markTranslationPending(item.element));
    const translations = await translateBatchWithFallback(batch);
    const records: TranslationRecord[] = [];

    translations.forEach((translation, index) => {
      const block = batch[index];
      if (!block || !isUsableTranslationText(translation)) {
        return;
      }

      insertTranslationAfter(block.element, translation);
      records.push(
        createTranslationRecord({
          sourceId: source.id,
          text: block.text,
          translation
        })
      );
    });

    if (records.length > 0) {
      await saveTranslations(source.id, records);
      translatedCount += records.length;
    }

    batch.forEach((item, index) => {
      if (!translations[index]) {
        markTranslationError(item.element);
      }
    });
  }

  if (translatedCount > 0) {
    showToast(`Translated ${Math.min(translatedCount, blocks.length)}/${blocks.length}`);
  } else {
    showToast("Setup needed");
  }
}

function injectPageActions(): void {
  if (document.querySelector(".rk-page-actions")) {
    return;
  }

  const actions = document.createElement("div");
  actions.className = "rk-page-actions";

  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "rk-page-actions-toggle";
  toggle.textContent = "T";
  toggle.title = "Readnote translation tools";
  toggle.setAttribute("aria-label", "Open Readnote translation tools");
  toggle.setAttribute("aria-expanded", "false");

  const menu = document.createElement("div");
  menu.className = "rk-page-actions-menu";

  function closePageActionsMenu(): void {
    actions.classList.remove("is-open");
    toggle.setAttribute("aria-expanded", "false");
  }

  const translate = document.createElement("button");
  translate.type = "button";
  translate.className = "rk-translate-button";
  translate.textContent = "Translate";
  translate.addEventListener("click", () => {
    closePageActionsMenu();
    runExtensionTask(translatePage);
  });

  const clearAll = document.createElement("button");
  clearAll.type = "button";
  clearAll.className = "rk-clear-all-button";
  clearAll.textContent = "Clear all";
  clearAll.addEventListener("click", () => {
    closePageActionsMenu();
    runExtensionTask(clearAllAnnotationsForCurrentPage);
  });

  toggle.addEventListener("click", () => {
    const open = actions.classList.toggle("is-open");
    toggle.setAttribute("aria-expanded", String(open));
  });
  menu.append(translate, clearAll);
  actions.append(toggle, menu);
  document.body.append(actions);

  document.addEventListener("pointerdown", (event) => {
    if (!actions.contains(event.target as Node)) {
      closePageActionsMenu();
    }
  });
}

async function bootstrap(): Promise<void> {
  if (
    !document.body ||
    location.protocol.startsWith("chrome") ||
    location.hostname === "youtube.com" ||
    location.hostname.endsWith(".youtube.com")
  ) {
    return;
  }

  currentSource = await captureSource();
  injectPageActions();
  await restoreAnnotations(currentSource.id);

  document.addEventListener("mouseup", (event) => {
    const target = event.target as Element | null;
    if (target?.closest?.(".rk-toolbar, .rk-note-editor, .rk-note-panel, .rk-note-bubble")) {
      return;
    }

    const annotationMark = target?.closest?.(".rk-annotation");
    window.setTimeout(() => {
      if (Date.now() < suppressSelectionToolbarUntil) {
        return;
      }

      if (annotationMark && !selectedText()) {
        return;
      }

      showToolbarForSelection();
    }, 0);
  });
  document.addEventListener("keyup", (event) => {
    if (event.key === "Escape") {
      discardPendingNoteDraft();
      removeToolbar();
      removeNoteEditor();
      removeNotePanel();
      return;
    }

    if ((event.target as Element | null)?.closest?.(".rk-toolbar, .rk-note-editor, .rk-note-panel")) {
      return;
    }

    window.setTimeout(showToolbarForSelection, 0);
  });
  document.addEventListener("scroll", () => {
    discardPendingNoteDraft();
    removeToolbar();
    removeNoteEditor();
    removeNotePanel();
  }, { passive: true });
  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type === "rk:translate-page") {
      runExtensionTask(translatePage);
    }
  });
}

runExtensionTask(bootstrap);
