(function() {
	//#region src/shared/ids.ts
	function canonicalizeUrl(rawUrl) {
		const url = new URL(rawUrl);
		url.hash = "";
		return url.toString();
	}
	function stableHash(input) {
		let hash = 14695981039346656037n;
		const prime = 1099511628211n;
		for (const char of input) {
			hash ^= BigInt(char.codePointAt(0) ?? 0);
			hash = BigInt.asUintN(64, hash * prime);
		}
		return hash.toString(16).padStart(16, "0");
	}
	async function sourceIdFromUrl(rawUrl) {
		return `src_${stableHash(canonicalizeUrl(rawUrl))}`;
	}
	//#endregion
	//#region src/shared/annotations.ts
	var STYLE_ORDER = [
		"yellow",
		"blue",
		"pink",
		"green",
		"underline",
		"wavy"
	];
	function uniqueStyles(styles) {
		return STYLE_ORDER.filter((style) => styles.includes(style));
	}
	function annotationIdFromLocation(input) {
		return `ann_${stableHash([
			input.sourceId,
			input.text,
			input.prefix,
			input.suffix
		].join("\n"))}`;
	}
	function createAnnotationRecord(input) {
		const styles = uniqueStyles(input.styles ?? (input.style ? [input.style] : []));
		return {
			id: annotationIdFromLocation(input),
			sourceId: input.sourceId,
			text: input.text,
			prefix: input.prefix,
			suffix: input.suffix,
			styles,
			note: input.note ?? "",
			translation: input.translation ?? "",
			savedAsExcerpt: input.savedAsExcerpt ?? false,
			createdAt: input.createdAt,
			updatedAt: input.createdAt
		};
	}
	function normalizeAnnotationRecord(annotation) {
		const styles = uniqueStyles(annotation.styles ?? (annotation.style ? [annotation.style] : []));
		return {
			...annotation,
			id: annotationIdFromLocation(annotation),
			styles,
			note: annotation.note ?? "",
			translation: annotation.translation ?? "",
			savedAsExcerpt: annotation.savedAsExcerpt ?? false
		};
	}
	function toggleAnnotationStyle(annotation, style, updatedAt = (/* @__PURE__ */ new Date()).toISOString()) {
		const normalized = normalizeAnnotationRecord(annotation);
		const styles = normalized.styles.includes(style) ? normalized.styles.filter((item) => item !== style) : uniqueStyles([...normalized.styles, style]);
		return {
			...normalized,
			styles,
			updatedAt
		};
	}
	function clearAnnotationMarkup(annotation, updatedAt = (/* @__PURE__ */ new Date()).toISOString()) {
		return {
			...normalizeAnnotationRecord(annotation),
			styles: [],
			note: "",
			translation: "",
			updatedAt
		};
	}
	function createExcerptFromAnnotation(annotation, source) {
		return {
			id: `ex_${stableHash([annotation.id, annotation.updatedAt].join("\n"))}`,
			sourceId: annotation.sourceId,
			sourceTitle: source.title,
			sourceUrl: source.url,
			text: annotation.text,
			note: annotation.note,
			translation: annotation.translation,
			createdAt: (/* @__PURE__ */ new Date()).toISOString()
		};
	}
	//#endregion
	//#region src/shared/storage.ts
	var SOURCE_PREFIX = "source:";
	var ANNOTATIONS_PREFIX = "annotations:";
	var TRANSLATIONS_PREFIX = "translations:";
	var EXCERPTS_KEY = "excerpts";
	function sourceKey(sourceId) {
		return `${SOURCE_PREFIX}${sourceId}`;
	}
	function annotationsKey(sourceId) {
		return `${ANNOTATIONS_PREFIX}${sourceId}`;
	}
	function translationsKey(sourceId) {
		return `${TRANSLATIONS_PREFIX}${sourceId}`;
	}
	async function getValue(key) {
		return (await chrome.storage.local.get(key))[key];
	}
	async function setValue(key, value) {
		await chrome.storage.local.set({ [key]: value });
	}
	async function saveSource(source) {
		const key = sourceKey(source.id);
		const existing = await getValue(key);
		const next = {
			...source,
			firstReadAt: existing?.firstReadAt ?? source.firstReadAt
		};
		await setValue(key, next);
		return next;
	}
	async function saveAnnotation(annotation) {
		const key = annotationsKey(annotation.sourceId);
		const existing = await getValue(key) ?? [];
		const normalized = normalizeAnnotationRecord(annotation);
		await setValue(key, [...existing.map(normalizeAnnotationRecord).filter((item) => item.id !== normalized.id), normalized].sort((a, b) => a.createdAt.localeCompare(b.createdAt)));
		return normalized;
	}
	function mergeAnnotations(annotations) {
		return annotations.map(normalizeAnnotationRecord).reduce((merged, annotation) => {
			const index = merged.findIndex((item) => item.id === annotation.id);
			if (index === -1) {
				merged.push(annotation);
				return merged;
			}
			const current = merged[index];
			merged[index] = normalizeAnnotationRecord({
				...current,
				styles: Array.from(/* @__PURE__ */ new Set([...current.styles, ...annotation.styles])),
				note: annotation.note || current.note,
				translation: annotation.translation || current.translation,
				savedAsExcerpt: current.savedAsExcerpt || annotation.savedAsExcerpt,
				createdAt: current.createdAt < annotation.createdAt ? current.createdAt : annotation.createdAt,
				updatedAt: current.updatedAt > annotation.updatedAt ? current.updatedAt : annotation.updatedAt
			});
			return merged;
		}, []).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
	}
	async function listAnnotations(sourceId) {
		return mergeAnnotations(await getValue(annotationsKey(sourceId)) ?? []);
	}
	async function deleteAnnotation(sourceId, annotationId) {
		const key = annotationsKey(sourceId);
		await setValue(key, (await getValue(key) ?? []).map(normalizeAnnotationRecord).filter((annotation) => annotation.id !== annotationId));
	}
	async function deleteAnnotations(sourceId) {
		await setValue(annotationsKey(sourceId), []);
	}
	async function saveExcerpt(excerpt) {
		await setValue(EXCERPTS_KEY, [...(await getValue(EXCERPTS_KEY) ?? []).filter((item) => item.id !== excerpt.id), excerpt].sort((a, b) => a.createdAt.localeCompare(b.createdAt)));
		return excerpt;
	}
	async function saveTranslations(sourceId, translations) {
		const key = translationsKey(sourceId);
		const existing = await getValue(key) ?? [];
		const byHash = /* @__PURE__ */ new Map();
		for (const translation of existing) byHash.set(translation.textHash, translation);
		for (const translation of translations) byHash.set(translation.textHash, translation);
		const next = Array.from(byHash.values()).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
		await setValue(key, next);
		return next;
	}
	async function listTranslations(sourceId) {
		return await getValue(translationsKey(sourceId)) ?? [];
	}
	//#endregion
	//#region src/shared/extension-lifecycle.ts
	var LIFECYCLE_ERROR_PATTERNS = ["Extension context invalidated", "Could not establish connection. Receiving end does not exist"];
	function isExtensionLifecycleError(error) {
		const message = error instanceof Error ? error.message : String(error ?? "");
		return LIFECYCLE_ERROR_PATTERNS.some((pattern) => message.includes(pattern));
	}
	async function settleExtensionTask(task, reportError = console.error) {
		try {
			await task();
		} catch (error) {
			if (!isExtensionLifecycleError(error)) reportError(error);
		}
	}
	function runExtensionTask(task, reportError = console.error) {
		settleExtensionTask(task, reportError);
	}
	//#endregion
	//#region src/article-reader/positioning.ts
	function computeToolbarPosition(input) {
		const gap = input.gap ?? 8;
		const margin = 8;
		let left = input.selectionEndRect.right + gap;
		let top = input.selectionEndRect.bottom + gap;
		if (left + input.toolbarSize.width > input.viewportSize.width - margin) left = input.selectionEndRect.left - input.toolbarSize.width - gap;
		if (top + input.toolbarSize.height > input.viewportSize.height - margin) top = input.selectionEndRect.top - input.toolbarSize.height - gap;
		return {
			left: Math.max(margin, Math.round(left)),
			top: Math.max(margin, Math.round(top))
		};
	}
	//#endregion
	//#region src/article-reader/rendering.ts
	function styleClass(style) {
		return `rk-${style}`;
	}
	function annotationClassName(annotation, options = {}) {
		const normalized = normalizeAnnotationRecord(annotation);
		return [
			"rk-annotation",
			options.noteMark ?? normalized.note.trim().length > 0 ? "rk-note-mark" : "",
			...normalized.styles.map(styleClass)
		].filter(Boolean).join(" ");
	}
	function orderAnnotationsForRendering(annotations) {
		return [...annotations].map(normalizeAnnotationRecord).sort((first, second) => {
			const lengthDelta = second.text.length - first.text.length;
			if (lengthDelta !== 0) return lengthDelta;
			return first.createdAt.localeCompare(second.createdAt);
		});
	}
	//#endregion
	//#region src/article-reader/text.ts
	function getContextForText(fullText, selectedText, contextChars = 80) {
		const index = fullText.indexOf(selectedText);
		if (index === -1) return {
			prefix: "",
			suffix: ""
		};
		return {
			prefix: fullText.slice(Math.max(0, index - contextChars), index),
			suffix: fullText.slice(index + selectedText.length, index + selectedText.length + contextChars)
		};
	}
	//#endregion
	//#region src/article-reader/translation.ts
	function translationRecordId(sourceId, text) {
		return `tr_${stableHash(`${sourceId}\n${text}`)}`;
	}
	function translationBlockKey(sourceId, text) {
		return stableHash(`${sourceId}\n${text}`);
	}
	function createTranslationRecord(input) {
		const now = input.now ?? (/* @__PURE__ */ new Date()).toISOString();
		const textHash = translationBlockKey(input.sourceId, input.text);
		return {
			id: translationRecordId(input.sourceId, input.text),
			sourceId: input.sourceId,
			textHash,
			text: input.text,
			translation: input.translation,
			createdAt: now,
			updatedAt: now
		};
	}
	function isUsableTranslationText(value) {
		if (typeof value !== "string") return false;
		const text = value.trim();
		return Boolean(text) && text !== "[object Object]";
	}
	function uniqueTranslationBlocks(blocks) {
		return blocks.filter((item, index, all) => all.findIndex((candidate) => candidate.key === item.key) === index);
	}
	function createTranslationBatches(blocks, cachedKeys, options = {}) {
		const firstBatchSize = Math.max(1, options.firstBatchSize ?? 1);
		const batchSize = Math.max(1, options.batchSize ?? 3);
		const pending = blocks.filter((block) => !cachedKeys.has(block.key));
		const batches = [];
		if (pending.length === 0) return batches;
		batches.push(pending.slice(0, firstBatchSize));
		for (let index = firstBatchSize; index < pending.length; index += batchSize) batches.push(pending.slice(index, index + batchSize));
		return batches;
	}
	//#endregion
	//#region src/article-reader/translation-dom.ts
	var excluded = [
		".rk-toolbar",
		".rk-note-editor",
		".rk-note-panel",
		".rk-note-bubble",
		".rk-toast",
		".rk-translation",
		".rk-page-actions",
		"nav",
		"footer",
		"script",
		"style",
		"noscript",
		"template",
		"pre",
		"code",
		"button",
		"input",
		"textarea",
		"select",
		"svg",
		"canvas",
		"iframe",
		"[hidden]",
		"[inert]",
		"[aria-hidden=\"true\"]",
		"[contenteditable]:not([contenteditable=\"false\"])",
		"[role=\"navigation\"]",
		"[role=\"menu\"]",
		"[role=\"dialog\"]"
	].join(", ");
	var blockTags = "h1,h2,h3,h4,h5,h6,p,li,blockquote,figcaption,dt,dd,td,th,caption,div,section,article,main,header,aside,[role=\"heading\"],[role=\"paragraph\"],[role=\"listitem\"]";
	/** Assign each visible text node to one block, rather than guessing from text length. */
	function collectPageTranslationBlocks(sourceId) {
		if (!document.body) return [];
		const parts = /* @__PURE__ */ new Map();
		const view = document.defaultView;
		function visit(element, owner) {
			if (element.matches(excluded)) return;
			if (element.matches("header, aside") && !element.closest("article, main, [role=\"main\"]")) return;
			const style = view?.getComputedStyle(element);
			if (style?.display === "none" || style?.visibility === "hidden" || style?.visibility === "collapse") return;
			if (element.matches(blockTags) && !(element.matches("p") && owner.matches("li, [role=\"listitem\"]"))) owner = element;
			for (const node of Array.from(element.childNodes)) if (node.nodeType === Node.TEXT_NODE) {
				const value = node.textContent ?? "";
				if (!parts.has(owner) && value.trim()) parts.set(owner, []);
				parts.get(owner)?.push(value);
			} else if (node instanceof HTMLElement) {
				if (node.matches("br")) parts.get(owner)?.push("\n");
				else {
					const separates = node.matches(blockTags + ",ul,ol,dl,table,tr");
					if (separates) parts.get(owner)?.push("\n");
					visit(node, owner);
					if (separates) parts.get(owner)?.push("\n");
				}
			}
		}
		visit(document.body, document.body);
		return Array.from(parts, ([element, chunks]) => {
			const text = chunks.join("").replace(/\s+/g, " ").trim();
			return {
				element,
				text,
				key: translationBlockKey(sourceId, text)
			};
		}).filter(({ text }) => /\p{L}/u.test(text));
	}
	var translationOwners = /* @__PURE__ */ new WeakMap();
	var translationNodes = /* @__PURE__ */ new WeakMap();
	var containedTranslation = "li,td,th,dt,dd,caption,div,section,article,main,body,header,aside,blockquote,[role=\"listitem\"]";
	function translationElement(element) {
		const known = translationNodes.get(element);
		if (known?.isConnected) return known;
		const candidate = element.matches(containedTranslation) ? element.querySelector(":scope > .rk-translation") : element.nextElementSibling;
		if (!(candidate instanceof HTMLElement) || !candidate.classList.contains("rk-translation")) return null;
		const owner = translationOwners.get(candidate);
		if (owner && owner !== element) return null;
		translationOwners.set(candidate, element);
		translationNodes.set(element, candidate);
		return candidate;
	}
	function ensureTranslationElement(element) {
		const existing = translationElement(element);
		if (existing) return existing;
		const translation = document.createElement("span");
		translation.className = "rk-translation";
		translation.lang = "zh-CN";
		translationOwners.set(translation, element);
		translationNodes.set(element, translation);
		if (element.matches(containedTranslation)) element.insertBefore(translation, element.querySelector(":scope > ul, :scope > ol"));
		else element.after(translation);
		return translation;
	}
	//#endregion
	//#region src/article-reader/index.ts
	var TOOLBAR_WIDTH = 312;
	var TOOLBAR_HEIGHT = 34;
	var currentSource = null;
	var toolbar = null;
	var noteEditor = null;
	var notePanel = null;
	var pendingSelectionText = "";
	var pendingSelectionRect = null;
	var pendingNoteDraft = null;
	var pendingAnnotationId = "";
	var suppressSelectionToolbarUntil = 0;
	function readableText() {
		if (!document.body) return "";
		const clone = document.body.cloneNode(true);
		clone.querySelectorAll(".rk-annotation").forEach((annotation) => {
			annotation.replaceWith(document.createTextNode(annotation.textContent ?? ""));
		});
		clone.querySelectorAll([
			".rk-toolbar",
			".rk-note-editor",
			".rk-note-panel",
			".rk-note-bubble",
			".rk-toast",
			".rk-translation",
			".rk-page-actions",
			".rk-translate-button"
		].join(", ")).forEach((element) => element.remove());
		return clone.innerText.trim();
	}
	function shouldSkipTextNode(node) {
		const parent = node.parentElement;
		if (!parent) return true;
		return Boolean(parent.closest([
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
		].join(", ")));
	}
	function rectFromDomRect(rect) {
		return {
			left: rect.left,
			top: rect.top,
			right: rect.right,
			bottom: rect.bottom,
			width: rect.width,
			height: rect.height
		};
	}
	function finalSelectionRect(range) {
		const rect = Array.from(range.getClientRects()).filter((rect) => rect.width > 0 && rect.height > 0).at(-1) ?? range.getBoundingClientRect();
		if (rect.width === 0 && rect.height === 0) return null;
		return rectFromDomRect(rect);
	}
	function removeToolbar() {
		toolbar?.remove();
		toolbar = null;
	}
	function removeNoteEditor() {
		noteEditor?.remove();
		noteEditor = null;
	}
	function removeNotePanel() {
		notePanel?.remove();
		notePanel = null;
	}
	function showToast(message) {
		document.querySelector(".rk-toast")?.remove();
		const toast = document.createElement("div");
		toast.className = "rk-toast";
		toast.textContent = message;
		document.body.append(toast);
		window.setTimeout(() => toast.remove(), 1600);
	}
	function shouldRenderAnnotation(annotation, options = {}) {
		const normalized = normalizeAnnotationRecord(annotation);
		return normalized.styles.length > 0 || normalized.note.trim().length > 0 || options.noteMark === true;
	}
	function appendNoteBubble(after, annotation) {
		if (!annotation.note.trim()) return;
		const bubble = document.createElement("button");
		bubble.type = "button";
		bubble.className = "rk-note-bubble";
		bubble.textContent = "✎";
		bubble.title = annotation.note;
		bubble.addEventListener("click", () => {
			selectAnnotationElement(after, annotation);
			showNotePanel(annotation, bubble.getBoundingClientRect());
		});
		after.after(bubble);
	}
	function selectAnnotationElement(element, annotation) {
		const selection = window.getSelection();
		if (!selection) return;
		const range = document.createRange();
		range.selectNodeContents(element);
		selection.removeAllRanges();
		selection.addRange(range);
		pendingSelectionText = annotation.text;
		pendingSelectionRect = rectFromDomRect(element.getBoundingClientRect());
		pendingAnnotationId = annotation.id;
		suppressSelectionToolbarUntil = Date.now() + 250;
	}
	function wrapFirstTextMatch(annotation, options = {}) {
		const normalized = normalizeAnnotationRecord(annotation);
		const renderOptions = {
			...options,
			noteMark: options.noteMark ?? normalized.note.trim().length > 0
		};
		if (!normalized.text.trim() || !shouldRenderAnnotation(normalized, renderOptions)) return false;
		const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
		let node = walker.nextNode();
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
						if (selectedText()) return;
						event.stopPropagation();
						selectAnnotationElement(mark, normalized);
						if (normalized.note.trim()) {
							showNotePanel(normalized, mark.getBoundingClientRect());
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
			node = walker.nextNode();
		}
		return false;
	}
	function clearRenderedAnnotations() {
		document.querySelectorAll(".rk-note-bubble").forEach((bubble) => bubble.remove());
		document.querySelectorAll(".rk-annotation").forEach((annotation) => {
			annotation.replaceWith(document.createTextNode(annotation.textContent ?? ""));
		});
		document.body.normalize();
	}
	async function captureSource() {
		const now = (/* @__PURE__ */ new Date()).toISOString();
		const url = canonicalizeUrl(location.href);
		return saveSource({
			id: await sourceIdFromUrl(url),
			url,
			title: document.title || url,
			siteName: location.hostname,
			capturedText: "",
			firstReadAt: now,
			lastReadAt: now,
			tags: ["reading/source"]
		});
	}
	async function restoreAnnotations(sourceId) {
		clearRenderedAnnotations();
		const annotations = await listAnnotations(sourceId);
		const pendingId = pendingNoteDraft?.sourceId === sourceId ? pendingNoteDraft.id : "";
		if (pendingNoteDraft?.sourceId === sourceId && !annotations.some((annotation) => annotation.id === pendingNoteDraft?.id)) annotations.push(pendingNoteDraft);
		const ordered = orderAnnotationsForRendering(annotations);
		for (const annotation of ordered) wrapFirstTextMatch(annotation, { noteMark: annotation.id === pendingId || annotation.note.trim().length > 0 });
	}
	async function rerenderCurrentAnnotations() {
		if (!currentSource) return;
		await restoreAnnotations(currentSource.id);
	}
	function selectedText() {
		return window.getSelection()?.toString().trim() ?? "";
	}
	function button(className, title, content) {
		const control = document.createElement("button");
		control.type = "button";
		control.className = className;
		control.title = title;
		if (typeof content === "string") control.textContent = content;
		else control.append(content);
		return control;
	}
	function colorDot(style) {
		const dot = document.createElement("span");
		dot.className = `rk-dot rk-dot-${style}`;
		return dot;
	}
	function eraserIcon() {
		const icon = document.createElement("span");
		icon.className = "rk-eraser-icon";
		return icon;
	}
	function wavyIcon() {
		const icon = document.createElement("span");
		icon.className = "rk-wavy-icon";
		icon.textContent = "U";
		return icon;
	}
	function divider() {
		const item = document.createElement("span");
		item.className = "rk-divider";
		return item;
	}
	function placeFloatingElement(element, rect, size) {
		const position = computeToolbarPosition({
			selectionEndRect: rect,
			toolbarSize: size,
			viewportSize: {
				width: window.innerWidth,
				height: window.innerHeight
			},
			gap: 8
		});
		element.style.left = `${position.left + window.scrollX}px`;
		element.style.top = `${position.top + window.scrollY}px`;
	}
	function showToolbarForSelection() {
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
		if (!rect) return;
		if (!Boolean(pendingAnnotationId && Date.now() < suppressSelectionToolbarUntil && text === pendingSelectionText)) pendingAnnotationId = "";
		pendingSelectionText = text;
		pendingSelectionRect = rect;
		toolbar = document.createElement("div");
		toolbar.className = "rk-toolbar";
		toolbar.addEventListener("mousedown", (event) => {
			event.preventDefault();
		});
		for (const style of [
			"yellow",
			"blue",
			"pink"
		]) {
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
			if (pendingSelectionRect) runExtensionTask(() => showNoteEditor(null, pendingSelectionRect));
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
		placeFloatingElement(toolbar, rect, {
			width: TOOLBAR_WIDTH,
			height: TOOLBAR_HEIGHT
		});
	}
	async function buildAnnotation(styles = [], note = "") {
		if (!currentSource || !pendingSelectionText) return null;
		const now = (/* @__PURE__ */ new Date()).toISOString();
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
	async function findStoredAnnotation(draft) {
		const annotations = await listAnnotations(draft.sourceId);
		if (pendingAnnotationId) {
			const selected = annotations.find((annotation) => annotation.id === pendingAnnotationId);
			if (selected) return selected;
		}
		return annotations.find((annotation) => annotation.id === draft.id) ?? null;
	}
	async function saveOrDeleteAnnotation(annotation) {
		const normalized = normalizeAnnotationRecord(annotation);
		if (normalized.styles.length === 0 && !normalized.note.trim() && !normalized.savedAsExcerpt) {
			await deleteAnnotation(normalized.sourceId, normalized.id);
			return null;
		}
		return saveAnnotation(normalized);
	}
	function resetPendingSelection() {
		window.getSelection()?.removeAllRanges();
		pendingSelectionText = "";
		pendingSelectionRect = null;
		pendingNoteDraft = null;
		pendingAnnotationId = "";
		removeToolbar();
		removeNoteEditor();
		removeNotePanel();
	}
	async function toggleStyleForSelection(style) {
		const draft = await buildAnnotation();
		if (!draft) return null;
		const saved = await saveOrDeleteAnnotation(toggleAnnotationStyle(await findStoredAnnotation(draft) ?? draft, style));
		await rerenderCurrentAnnotations();
		resetPendingSelection();
		return saved;
	}
	async function clearAnnotationForSelection() {
		const draft = await buildAnnotation();
		if (!draft) return;
		const existing = await findStoredAnnotation(draft);
		if (existing) {
			await saveOrDeleteAnnotation(clearAnnotationMarkup(existing));
			await rerenderCurrentAnnotations();
			showToast("Cleared");
		}
		resetPendingSelection();
	}
	async function clearAllAnnotationsForCurrentPage() {
		if (!currentSource) return;
		await deleteAnnotations(currentSource.id);
		clearRenderedAnnotations();
		resetPendingSelection();
		showToast("Cleared");
	}
	function discardPendingNoteDraft() {
		if (!pendingNoteDraft) return;
		pendingNoteDraft = null;
		runExtensionTask(rerenderCurrentAnnotations);
	}
	async function deleteNoteFromAnnotation(annotation) {
		await saveOrDeleteAnnotation({
			...(await listAnnotations(annotation.sourceId)).find((item) => item.id === annotation.id) ?? annotation,
			note: "",
			updatedAt: (/* @__PURE__ */ new Date()).toISOString()
		});
		removeNotePanel();
		await rerenderCurrentAnnotations();
		resetPendingSelection();
		showToast("Note deleted");
	}
	function showNotePanel(annotation, rect) {
		removeToolbar();
		removeNoteEditor();
		removeNotePanel();
		const normalized = normalizeAnnotationRecord(annotation);
		const normalizedRect = "toJSON" in rect ? rectFromDomRect(rect) : rect;
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
	async function showNoteEditor(annotation, rect) {
		removeNoteEditor();
		removeNotePanel();
		const normalizedRect = "toJSON" in rect ? rectFromDomRect(rect) : rect;
		const draft = annotation ?? await buildAnnotation();
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
				if (draft) await saveOrDeleteAnnotation({
					...await findStoredAnnotation(draft) ?? draft,
					note: textarea.value,
					updatedAt: (/* @__PURE__ */ new Date()).toISOString()
				});
				else {
					const nextDraft = await buildAnnotation([], textarea.value);
					if (nextDraft) await saveOrDeleteAnnotation({
						...await findStoredAnnotation(nextDraft) ?? nextDraft,
						note: textarea.value,
						updatedAt: (/* @__PURE__ */ new Date()).toISOString()
					});
				}
				pendingNoteDraft = null;
				await rerenderCurrentAnnotations();
				resetPendingSelection();
			});
		});
		noteEditor.append(textarea, done);
		document.body.append(noteEditor);
		placeFloatingElement(noteEditor, normalizedRect, {
			width: 220,
			height: 132
		});
		textarea.focus();
	}
	async function syncExcerpt(excerpt) {
		try {
			const data = await chrome.runtime.sendMessage({
				action: "syncArticleExcerpt",
				excerpt
			});
			if (!data.success) return "saved";
			if (data.notion === "synced") return "synced";
			return data.obsidian === "synced" ? "obsidian_only" : "saved";
		} catch {
			return "saved";
		}
	}
	async function saveExcerptFromSelection() {
		const draft = await buildAnnotation();
		if (!draft || !currentSource) return;
		const annotation = await saveOrDeleteAnnotation({
			...await findStoredAnnotation(draft) ?? draft,
			savedAsExcerpt: true,
			updatedAt: (/* @__PURE__ */ new Date()).toISOString()
		});
		if (!annotation) return;
		const excerpt = createExcerptFromAnnotation(annotation, {
			title: currentSource.title,
			url: currentSource.url
		});
		await saveExcerpt(excerpt);
		const syncStatus = await syncExcerpt(excerpt);
		showToast(syncStatus === "synced" ? "Synced" : syncStatus === "obsidian_only" ? "Obsidian synced" : "Saved");
		resetPendingSelection();
	}
	function insertTranslationAfter(element, text) {
		const translation = ensureTranslationElement(element);
		translation.textContent = text;
		translation.classList.remove("rk-translation-pending", "rk-translation-error");
	}
	function markTranslationPending(element) {
		const translation = ensureTranslationElement(element);
		translation.classList.remove("rk-translation-error");
		translation.classList.add("rk-translation-pending");
		translation.textContent = "Translating...";
	}
	function markTranslationError(element) {
		const translation = translationElement(element);
		if (!translation) return;
		translation.classList.remove("rk-translation-pending");
		translation.classList.add("rk-translation-error");
		translation.textContent = "Translation paused. Tap Translate to retry.";
	}
	function collectTranslationBlocks(sourceId) {
		return collectPageTranslationBlocks(sourceId);
	}
	async function requestTranslations(paragraphs) {
		let timeoutId;
		try {
			const timeout = new Promise((_resolve, reject) => {
				timeoutId = window.setTimeout(() => reject(/* @__PURE__ */ new Error("Translation timed out")), 13e4);
			});
			const data = await Promise.race([timeout, chrome.runtime.sendMessage({
				action: "translateArticle",
				payload: {
					source: {
						title: document.title,
						url: canonicalizeUrl(location.href)
					},
					paragraphs
				}
			})]);
			if (!data.success) return null;
			if (!Array.isArray(data.translations) || data.translations.length !== paragraphs.length) return null;
			return data.translations.map((value) => isUsableTranslationText(value) ? value.trim() : "");
		} catch {
			return null;
		} finally {
			window.clearTimeout(timeoutId);
		}
	}
	async function translateBatchWithFallback(batch) {
		const translations = await requestTranslations(batch.map((item) => item.text)) ?? batch.map(() => "");
		if (batch.length === 1) return translations;
		for (let index = 0; index < batch.length; index += 1) if (!isUsableTranslationText(translations[index])) {
			const [translation] = await requestTranslations([batch[index].text]) ?? [];
			translations[index] = translation ?? "";
		}
		return translations;
	}
	var activeTranslation = null;
	function translatePage() {
		if (!activeTranslation) activeTranslation = translatePageOnce().finally(() => {
			activeTranslation = null;
		});
		return activeTranslation;
	}
	async function translatePageOnce() {
		if (!currentSource) currentSource = await captureSource();
		const source = currentSource;
		const blocks = collectTranslationBlocks(source.id);
		if (blocks.length === 0) {
			showToast("Nothing to translate");
			return;
		}
		const cached = await listTranslations(source.id);
		const cachedByKey = new Map(cached.filter((translation) => isUsableTranslationText(translation.translation)).map((translation) => [translation.textHash, translation]));
		const cachedKeys = new Set(cachedByKey.keys());
		const cachedBlockCount = blocks.filter((block) => cachedByKey.has(block.key)).length;
		for (const block of blocks) {
			const translation = cachedByKey.get(block.key)?.translation;
			if (translation) insertTranslationAfter(block.element, translation);
		}
		const batches = createTranslationBatches(uniqueTranslationBlocks(blocks), cachedKeys, {
			firstBatchSize: 1,
			batchSize: 3
		});
		if (batches.length === 0) {
			showToast("Translated");
			return;
		}
		showToast(cachedBlockCount > 0 ? "Continuing translation" : "Translating");
		let translatedCount = cachedBlockCount;
		for (const batch of batches) {
			const batchKeys = new Set(batch.map((item) => item.key));
			const occurrences = blocks.filter((item) => batchKeys.has(item.key) && item.element.isConnected);
			occurrences.forEach((item) => markTranslationPending(item.element));
			const translations = await translateBatchWithFallback(batch);
			const records = [];
			translations.forEach((translation, index) => {
				const block = batch[index];
				if (!block || !isUsableTranslationText(translation)) return;
				occurrences.filter((item) => item.key === block.key).forEach((item) => {
					insertTranslationAfter(item.element, translation);
				});
				records.push(createTranslationRecord({
					sourceId: source.id,
					text: block.text,
					translation
				}));
			});
			if (records.length > 0) {
				await saveTranslations(source.id, records);
				const savedKeys = new Set(records.map((record) => record.textHash));
				translatedCount += occurrences.filter((item) => savedKeys.has(item.key)).length;
			}
			batch.forEach((item, index) => {
				if (!isUsableTranslationText(translations[index])) occurrences.filter((block) => block.key === item.key).forEach((block) => markTranslationError(block.element));
			});
		}
		if (translatedCount > 0) showToast(`Translated ${Math.min(translatedCount, blocks.length)}/${blocks.length}`);
		else showToast("Setup needed");
	}
	function injectPageActions() {
		if (document.querySelector(".rk-page-actions")) return;
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
		function closePageActionsMenu() {
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
			if (!actions.contains(event.target)) closePageActionsMenu();
		});
	}
	async function bootstrap() {
		if (!document.body || location.protocol.startsWith("chrome") || location.hostname === "youtube.com" || location.hostname.endsWith(".youtube.com")) return;
		currentSource = await captureSource();
		injectPageActions();
		await restoreAnnotations(currentSource.id);
		document.addEventListener("mouseup", (event) => {
			const target = event.target;
			if (target?.closest?.(".rk-toolbar, .rk-note-editor, .rk-note-panel, .rk-note-bubble")) return;
			const annotationMark = target?.closest?.(".rk-annotation");
			window.setTimeout(() => {
				if (Date.now() < suppressSelectionToolbarUntil) return;
				if (annotationMark && !selectedText()) return;
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
			if (event.target?.closest?.(".rk-toolbar, .rk-note-editor, .rk-note-panel")) return;
			window.setTimeout(showToolbarForSelection, 0);
		});
		document.addEventListener("scroll", () => {
			discardPendingNoteDraft();
			removeToolbar();
			removeNoteEditor();
			removeNotePanel();
		}, { passive: true });
		chrome.runtime.onMessage.addListener((message) => {
			if (message?.type === "rk:translate-page") runExtensionTask(translatePage);
		});
	}
	runExtensionTask(bootstrap);
	//#endregion
})();
