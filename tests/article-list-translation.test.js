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
