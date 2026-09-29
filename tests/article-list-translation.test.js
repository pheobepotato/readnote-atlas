const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const before = 'For years people assumed Google would disintermediate Expedia and Booking, but both thrived.';
const bullets = [
  'First, both companies make most of their revenue from lodging, not advertising; reservations finish on their platform.',
  'Second, getting lodging onto a platform, managing payments and dealing with fraud is difficult work.',
  'Third, both companies became some of Google’s largest customers because their capabilities were complementary.'
];
const after = 'Some of these principles hold true for Muse and agents generally.';

function reader(html) {
  const dom = new JSDOM(html, { url: 'https://example.com/article', runScripts: 'outside-only' });
  const { window } = dom;
  // jsdom has no layout implementation of innerText.
  Object.defineProperty(window.HTMLElement.prototype, 'innerText', { get() { return this.textContent; } });
  const storage = {};
  const requests = [];
  window.chrome = { storage: { local: {
    get: async key => ({ [key]: storage[key] }),
    set: async values => Object.assign(storage, values)
  } }, runtime: { sendMessage: async ({ payload }) => {
    requests.push(...payload.paragraphs);
    return { success: true, translations: payload.paragraphs.map(text => `中文：${text}`) };
  } } };
  const bundle = fs.readFileSync(path.join(__dirname, '../article-reader.js'), 'utf8');
  assert.ok(bundle.includes('runExtensionTask(bootstrap);'));
  window.eval(bundle.replace('runExtensionTask(bootstrap);', `
    currentSource = { id: 'test-source' };
    window.readerTest = { collectTranslationBlocks, translatePage };
  `));
  return { dom, window, requests, api: window.readerTest };
}

test('article translation sends and displays all three bullets between paragraphs', async () => {
  const { dom, window, requests, api } = reader(`<article><p>${before}</p><ul>${bullets.map(t => `<li>${t}</li>`).join('')}</ul><p>${after}</p></article>`);
  try {
    await api.translatePage();
    assert.deepEqual(requests, [before, ...bullets, after]);
    assert.equal(window.document.querySelectorAll('.rk-translation').length, 5);
    for (const item of window.document.querySelectorAll('li')) {
      assert.ok(item.querySelector('.rk-translation'), 'each bullet has its own Chinese translation');
    }
    await api.translatePage();
    assert.equal(requests.length, 5, 'retry uses cached translations without translating generated text');
    assert.equal(window.document.querySelectorAll('.rk-translation').length, 5);
  } finally { dom.window.close(); }
});

test('ordered and nested lists translate each item once, including wrapped paragraphs', async () => {
  const { dom, window, requests, api } = reader(`<article><ol><li><p>${bullets[0]}</p><ul><li>${bullets[1]}</li></ul></li><li><p>${bullets[2]}</p></li></ol></article><nav><ul><li>${before}</li></ul></nav>`);
  try {
    await api.translatePage();
    assert.deepEqual(requests, bullets);
    const items = [...window.document.querySelectorAll('article li')];
    items.forEach((item, index) => {
      assert.equal(item.querySelector(':scope > .rk-translation').textContent, `中文：${bullets[index]}`);
    });
    assert.equal(items[0].querySelector(':scope > .rk-translation').nextElementSibling.tagName, 'UL');
    assert.equal(window.document.querySelector('nav .rk-translation'), null);
    await api.translatePage();
    assert.equal(requests.length, 3);
    assert.equal(window.document.querySelectorAll('.rk-translation').length, 3);
  } finally { dom.window.close(); }
});

test('failed list translations retry in place without using error text as source', async () => {
  const { dom, window, requests, api } = reader(`<ul><li>${bullets[0]}</li></ul>`);
  try {
    const sendMessage = window.chrome.runtime.sendMessage;
    window.chrome.runtime.sendMessage = async () => ({ success: false });
    await api.translatePage();
    assert.equal(window.document.querySelectorAll('li > .rk-translation-error').length, 1);
    window.chrome.runtime.sendMessage = sendMessage;
    await api.translatePage();
    assert.deepEqual(requests, [bullets[0]]);
    assert.equal(window.document.querySelectorAll('li > .rk-translation').length, 1);
    assert.equal(window.document.querySelectorAll('.rk-translation-error, .rk-translation-pending').length, 0);
  } finally { dom.window.close(); }
});

test('short text, all heading levels, quotes, captions, definitions, cells and div prose are included', async () => {
  const texts = ['Why?', 'Short paragraph.', 'Short bullet.', 'A quotation.', 'Figure one.', 'Term', 'Definition.', 'Header', 'Cell text.', 'Plain div prose.'];
  const { dom, requests, api } = reader(`<article><header><h3>${texts[0]}</h3></header><p>${texts[1]}</p><ul><li>${texts[2]}</li></ul><blockquote>${texts[3]}</blockquote><figure><figcaption>${texts[4]}</figcaption></figure><dl><dt>${texts[5]}</dt><dd>${texts[6]}</dd></dl><table><tr><th>${texts[7]}</th><td>${texts[8]}</td></tr></table><div>${texts[9]}</div></article>`);
  try { await api.translatePage(); assert.deepEqual(requests, texts); }
  finally { dom.window.close(); }
});

test('identical source text is translated once but rendered at every occurrence', async () => {
  const { dom, window, requests, api } = reader(`<article><p>${before}</p><p>${before}</p></article>`);
  try {
    await api.translatePage();
    assert.deepEqual(requests, [before]);
    assert.equal(window.document.querySelectorAll('.rk-translation').length, 2);
  } finally { dom.window.close(); }
});

test('invalid partial responses retry only missing entries and never remain pending', async () => {
  const { dom, window, api } = reader(`<article>${[before, ...bullets].map(t => `<p>${t}</p>`).join('')}</article>`);
  const calls = [];
  window.chrome.runtime.sendMessage = async ({payload: {paragraphs}}) => {
    calls.push([...paragraphs]);
    return {success: true, translations: paragraphs.length === 3 ? ['有效中文', '  ', {text: 'wrong shape'}] : ['补全中文']};
  };
  try {
    await api.translatePage();
    assert.deepEqual(calls, [[before], bullets, [bullets[1]], [bullets[2]]]);
    assert.equal(window.document.querySelectorAll('.rk-translation').length, 4);
    assert.equal(window.document.querySelectorAll('.rk-translation-pending, .rk-translation-error').length, 0);
  } finally { dom.window.close(); }
});

test('mixed container and paragraph text keep separate translation targets across retries', async () => {
  const { dom, window, requests, api } = reader('<article><div>Container opening.<p>Inner paragraph.</p>Container ending.</div><div><p>Another paragraph.</p>Trailing container text.</div></article>');
  try {
    await api.translatePage();
    assert.equal(window.document.querySelectorAll('.rk-translation').length, 4);
    assert.deepEqual(requests, ['Container opening. Container ending.', 'Inner paragraph.', 'Another paragraph.', 'Trailing container text.']);
    await api.translatePage();
    assert.equal(window.document.querySelectorAll('.rk-translation').length, 4);
    assert.equal(requests.length, 4);
  } finally { dom.window.close(); }
});

test('hidden text, controls, code and extension UI never become article source', async () => {
  const { dom, requests, api } = reader(`<article><p>Visible <em>inline</em><br>prose.</p><div hidden>Hidden attribute.</div><div style="display:none"><p>Hidden ancestor.</p></div><p style="visibility:hidden">Invisible prose.</p><p aria-hidden="true">Hidden to readers.</p><nav>Navigation words.</nav><button>Click me.</button><pre>Code example.</pre><div contenteditable="true">Draft text.</div><span class="rk-note-bubble">My note.</span></article>`);
  try { await api.translatePage(); assert.deepEqual(requests, ['Visible inline prose.']); }
  finally { dom.window.close(); }
});

test('repeated clicks share an in-flight run and later clicks collect new content', async () => {
  const { dom, window, requests, api } = reader('<article><p>Initial content.</p></article>');
  const original = window.chrome.runtime.sendMessage;
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  window.chrome.runtime.sendMessage = async message => { await gate; return original(message); };
  try {
    const first = api.translatePage();
    const second = api.translatePage();
    release();
    await Promise.all([first, second]);
    assert.deepEqual(requests, ['Initial content.']);
    window.document.querySelector('article').insertAdjacentHTML('beforeend', '<h6>New heading</h6><p>New content.</p>');
    await api.translatePage();
    assert.deepEqual(requests, ['Initial content.', 'New heading', 'New content.']);
    assert.equal(window.document.querySelectorAll('.rk-translation').length, 3);
  } finally { dom.window.close(); }
});

test('a lost runtime reply exits pending state and allows a later retry', async () => {
  const { dom, window, requests, api } = reader('<p>A complete sentence.</p>');
  const originalSend = window.chrome.runtime.sendMessage;
  const originalTimer = window.setTimeout.bind(window);
  let expire;
  window.setTimeout = (callback, delay) => delay === 130_000 ? (expire = callback, 0) : originalTimer(callback, delay);
  window.chrome.runtime.sendMessage = () => new Promise(() => {});
  try {
    const run = api.translatePage();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(typeof expire, 'function');
    expire();
    await run;
    assert.equal(window.document.querySelectorAll('.rk-translation-error').length, 1);
    window.chrome.runtime.sendMessage = originalSend;
    await api.translatePage();
    assert.deepEqual(requests, ['A complete sentence.']);
    assert.equal(window.document.querySelectorAll('.rk-translation-pending, .rk-translation-error').length, 0);
  } finally { dom.window.close(); }
});

test('all six heading levels are collected, including one-word headings', async () => {
  const { dom, requests, api } = reader('<article>' + Array.from({length: 6}, (_, i) => `<h${i + 1}>Title${i + 1}</h${i + 1}>`).join('') + '</article>');
  try { await api.translatePage(); assert.deepEqual(requests, ['Title1', 'Title2', 'Title3', 'Title4', 'Title5', 'Title6']); }
  finally { dom.window.close(); }
});
