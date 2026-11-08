const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

function pageActions() {
  const dom = new JSDOM('<button id="site">Site control</button>', { runScripts: 'outside-only' });
  const style = dom.window.document.createElement('style');
  style.textContent = fs.readFileSync(path.join(__dirname, '../article-reader.css'), 'utf8');
  dom.window.document.head.append(style);
  const bundle = fs.readFileSync(path.join(__dirname, '../article-reader.js'), 'utf8');
  dom.window.eval(bundle.replace('runExtensionTask(bootstrap);', 'injectPageActions();'));
  return dom;
}

test('article launcher leaves the top corner and its surrounding space available', () => {
  const dom = pageActions();
  try {
    const { document, getComputedStyle } = dom.window;
    const actions = document.querySelector('.rk-page-actions');
    const toggle = document.querySelector('.rk-page-actions-toggle');
    const containerStyle = getComputedStyle(actions);
    assert.equal(containerStyle.top, 'auto', 'no top corner anchor');
    assert.ok(Math.abs(parseFloat(containerStyle.bottom) - dom.window.innerHeight * 0.35) < 1);
    assert.equal(containerStyle.pointerEvents, 'none', 'container never intercepts webpage clicks');
    assert.equal(getComputedStyle(toggle).pointerEvents, 'auto');
    assert.ok(Number(getComputedStyle(toggle).opacity) > 0, 'no invisible clickable launcher');
    assert.equal(getComputedStyle(document.querySelector('.rk-page-actions-menu')).visibility, 'hidden');
  } finally { dom.window.close(); }
});

test('relocated article launcher opens tools and dismisses on a webpage pointerdown', () => {
  const dom = pageActions();
  try {
    const { document, getComputedStyle, Event } = dom.window;
    const toggle = document.querySelector('.rk-page-tools-toggle');
    const menu = document.querySelector('.rk-page-actions-menu');
    toggle.click();
    assert.equal(toggle.getAttribute('aria-expanded'), 'true');
    assert.equal(getComputedStyle(menu).visibility, 'visible');
    for (const button of menu.querySelectorAll('button')) {
      assert.equal(getComputedStyle(button).pointerEvents, 'auto');
    }
    document.querySelector('#site').dispatchEvent(new Event('pointerdown', { bubbles: true }));
    assert.equal(toggle.getAttribute('aria-expanded'), 'false');
    assert.equal(getComputedStyle(menu).visibility, 'hidden');
  } finally { dom.window.close(); }
});
