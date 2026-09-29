import { translationBlockKey, type TranslationBlock } from "./translation";

export type PageTranslationBlock = TranslationBlock & { element: HTMLElement };

const excluded = [
  '.rk-toolbar', '.rk-note-editor', '.rk-note-panel', '.rk-note-bubble',
  '.rk-toast', '.rk-translation', '.rk-page-actions',
  'nav', 'footer', 'script', 'style', 'noscript', 'template', 'pre', 'code',
  'button', 'input', 'textarea', 'select', 'svg', 'canvas', 'iframe',
  '[hidden]', '[inert]', '[aria-hidden="true"]', '[contenteditable]:not([contenteditable="false"])',
  '[role="navigation"]', '[role="menu"]', '[role="dialog"]'
].join(', ');
const blockTags = 'h1,h2,h3,h4,h5,h6,p,li,blockquote,figcaption,dt,dd,td,th,caption,div,section,article,main,header,aside,[role="heading"],[role="paragraph"],[role="listitem"]';

/** Assign each visible text node to one block, rather than guessing from text length. */
export function collectPageTranslationBlocks(sourceId: string): PageTranslationBlock[] {
  if (!document.body) return [];
  const parts = new Map<HTMLElement, string[]>();
  const view = document.defaultView;

  function visit(element: HTMLElement, owner: HTMLElement): void {
    if (element.matches(excluded)) return;
    if (element.matches('header, aside') && !element.closest('article, main, [role="main"]')) return;
    const style = view?.getComputedStyle(element);
    if (style?.display === 'none' || style?.visibility === 'hidden' || style?.visibility === 'collapse') return;

    // Wrapped paragraphs belong to their list item; nested lists still own their own text.
    if (element.matches(blockTags) && !(element.matches('p') && owner.matches('li, [role="listitem"]'))) {
      owner = element;
    }
    for (const node of Array.from(element.childNodes)) {
      if (node.nodeType === Node.TEXT_NODE) {
        const value = node.textContent ?? '';
        if (!parts.has(owner) && value.trim()) parts.set(owner, []);
        parts.get(owner)?.push(value);
      } else if (node instanceof HTMLElement) {
        if (node.matches('br')) {
          parts.get(owner)?.push('\n');
        } else {
          const separates = node.matches(blockTags + ',ul,ol,dl,table,tr');
          if (separates) parts.get(owner)?.push('\n');
          visit(node, owner);
          if (separates) parts.get(owner)?.push('\n');
        }
      }
    }
  }
  visit(document.body, document.body);
  return Array.from(parts, ([element, chunks]) => {
    const text = chunks.join('').replace(/\s+/g, ' ').trim();
    return { element, text, key: translationBlockKey(sourceId, text) };
  }).filter(({ text }) => /\p{L}/u.test(text));
}

const translationOwners = new WeakMap<HTMLElement, HTMLElement>();
const translationNodes = new WeakMap<HTMLElement, HTMLElement>();

const containedTranslation = 'li,td,th,dt,dd,caption,div,section,article,main,body,header,aside,blockquote,[role="listitem"]';

export function translationElement(element: HTMLElement): HTMLElement | null {
  const known = translationNodes.get(element);
  if (known?.isConnected) return known;
  const candidate = element.matches(containedTranslation)
    ? element.querySelector<HTMLElement>(':scope > .rk-translation')
    : element.nextElementSibling;
  if (!(candidate instanceof HTMLElement) || !candidate.classList.contains('rk-translation')) return null;
  const owner = translationOwners.get(candidate);
  if (owner && owner !== element) return null;
  translationOwners.set(candidate, element);
  translationNodes.set(element, candidate);
  return candidate;
}

export function ensureTranslationElement(element: HTMLElement): HTMLElement {
  const existing = translationElement(element);
  if (existing) return existing;
  const translation = document.createElement('span');
  translation.className = 'rk-translation';
  translation.lang = 'zh-CN';
  translationOwners.set(translation, element);
  translationNodes.set(element, translation);
  if (element.matches(containedTranslation)) {
    element.insertBefore(translation, element.querySelector(':scope > ul, :scope > ol'));
  } else {
    element.after(translation);
  }
  return translation;
}
