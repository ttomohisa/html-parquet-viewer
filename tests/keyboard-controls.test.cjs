const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

// Actual shipped handlers, with a small DOM/focus adapter and parser-boundary doubles.
// A button's native Tab/Enter/Space behavior and the OS picker still need browser QA.
const html = fs.readFileSync(process.env.PARQUET_HTML || path.join(__dirname, '..', 'parquet-viewer.html'), 'utf8');
const start = html.indexOf('var D = e => document.getElementById(e)');
assert(start > 0);
const app = html.slice(start, html.indexOf('</script>', start));
const decode = text => text.replace(/&(amp|lt|gt|quot|#39);/g, (_, key) => ({ amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'" })[key]);
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function setup() {
  const elements = new Map(), reads = [], clicks = [], errors = [], focusEvents = [];
  const document = { activeElement: null };
  class Element {
    constructor(tagName = 'div', attrs = {}) {
      this.tagName = tagName.toUpperCase(); this.attrs = attrs; this.children = []; this.parentElement = null;
      this.dataset = {}; this.style = {}; this.listeners = {}; this._html = ''; this.textContent = ''; this.value = ''; this.disabled = false; this.hidden = false;
      this.classList = { add() {}, remove() {} };
      for (const [name, value] of Object.entries(attrs)) this.setAttribute(name, value);
    }
    setAttribute(name, value) {
      this.attrs[name] = String(value);
      if (name === 'id') { this.id = value; elements.set(value, this); }
      if (name.startsWith('data-')) this.dataset[name.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = value;
    }
    removeAttribute(name) { delete this.attrs[name]; }
    getAttribute(name) { return this.attrs[name] ?? null; }
    hasAttribute(name) { return Object.hasOwn(this.attrs, name); }
    matches(selector) {
      if (selector.startsWith('.')) return (this.attrs.class || '').split(/\s+/).includes(selector.slice(1));
      const m = selector.match(/^([\w-]+)?(?:\[([\w-]+)(?:="([^"]*)")?\])?$/);
      return !!m && (!m[1] || this.tagName === m[1].toUpperCase()) && (!m[2] || this.hasAttribute(m[2]) && (m[3] === undefined || this.getAttribute(m[2]) === m[3]));
    }
    closest(selector) { for (let node = this; node; node = node.parentElement) if (node.matches(selector)) return node; return null; }
    contains(node) { return !!node && (node === this || this.children.some(child => child.contains(node))); }
    querySelectorAll(selector) { return this.children.flatMap(child => [...(child.matches(selector) ? [child] : []), ...child.querySelectorAll(selector)]); }
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
    append(child) { child.parentElement = this; this.children.push(child); }
    remove() { if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(child => child !== this); this.parentElement = null; }
    addEventListener(name, handler) { this.listeners[name] = handler; }
    focus() { document.activeElement = this; focusEvents.push(this); }
    scrollIntoView() {}
    click() {
      clicks.push(this.id || this.tagName);
      if (this.disabled) return;
      const event = { target: this, preventDefault() {}, stopPropagation() { this.stopped = true; } };
      let result;
      // Copy the propagation path before handlers replace the DOM, like a real event.
      const ancestors = []; for (let node = this; node; node = node.parentElement) ancestors.push(node);
      for (const node of ancestors) { if (node.onclick) result = node.onclick(event); if (event.stopped) break; }
      return result;
    }
    get innerHTML() { return this._html; }
    set innerHTML(value) {
      if (document.activeElement !== this && this.contains(document.activeElement)) document.activeElement = document.body;
      this.children.forEach(child => { child.parentElement = null; }); this.children = []; this._html = value;
      parse(value, this);
    }
  }
  function parse(markup, parent) {
    const stack = [parent];
    for (const match of markup.matchAll(/<\/?([a-z][\w-]*)\b([^>]*)>/gi)) {
      const [token, tag, rest] = match;
      if (token.startsWith('</')) { if (stack.length > 1) stack.pop(); continue; }
      const attrs = {};
      for (const attr of rest.matchAll(/([\w-]+)(?:="([^"]*)")?/g)) attrs[attr[1]] = decode(attr[2] || '');
      const child = new Element(tag, attrs); stack.at(-1).append(child);
      if (!/^(input|meta|link|br|hr|img)$/i.test(tag) && !token.endsWith('/>')) stack.push(child);
    }
  }
  document.body = new Element('body'); document.activeElement = document.body;
  const D = id => { if (!elements.has(id)) document.body.append(new Element('div', { id })); return elements.get(id); };
  // Initial static element tags/attributes matter for picker/button contracts.
  for (const match of html.slice(0, html.indexOf('<script')).matchAll(/<([a-z][\w-]*)\b([^>]*\bid="([^"]+)"[^>]*)>/gi)) {
    const attrs = {}; for (const attr of match[2].matchAll(/([\w-]+)(?:="([^"]*)")?/g)) attrs[attr[1]] = decode(attr[2] || '');
    document.body.append(new Element(match[1], attrs));
  }
  Object.assign(document, { getElementById: D, querySelectorAll: () => [], createElement: tag => new Element(tag) });
  const ctx = vm.createContext({ document, console: { error: error => errors.push(error) }, Date, Uint8Array, Blob,
    navigator: { clipboard: { writeText: async () => {} } }, window: { isSecureContext: true }, hn: {},
    setTimeout() {}, URL: { createObjectURL: () => 'blob:test', revokeObjectURL() {} },
    Jt: options => { const read = deferred(); reads.push({ options, ...read }); return read.promise; },
    Oe: async () => ({}), J: () => ({ children: [] }) });
  vm.runInContext(app, ctx);
  const run = code => vm.runInContext(code, ctx);
  function seed(id, rows = [{ value: 2 }, { value: 1 }], name = id + '.parquet', complete = true) {
    ctx.fixture = { id, rows, name, complete };
    run(`{ const { id, rows, name, complete } = fixture; const s = emptySession({name, size: 64}); s.metadata = {num_rows: rows.length, row_groups: [], version: 1}; s.schema = J(); s.rows = rows.length; if (complete) { s.lastRows = rows; s.lastColumns = [...new Set(rows.flatMap(Object.keys))]; s.completedPage = {file: s.file, page: 0, pageSize: 100, rowStart: 0, rows, columns: s.lastColumns}; } tabs.set(id, s); }`);
  }
  const tab = id => D('tabs').querySelectorAll('[data-tab]').find(node => node.dataset.tab === id);
  const close = id => D('tabs').querySelectorAll('[data-close]').find(node => node.dataset.close === id);
  const header = name => D('data-head').querySelectorAll('th[data-column]').find(node => node.dataset.column === name);
  const sort = name => header(name)?.querySelector('button');
  return { D, document, run, ctx, seed, tab, close, header, sort, reads, clicks, errors, focusEvents };
}
function nativeButton(node, description) {
  assert(node, description + ' exists');
  assert.equal(node.tagName, 'BUTTON', description + ' uses a native button');
  assert.equal(node.getAttribute('type'), 'button', description + ' is not a submit control');
  assert.notEqual(node.getAttribute('tabindex'), '-1', description + ' stays in native Tab order');
  assert.equal(node.querySelector('button'), null, description + ' does not contain another button');
}
async function loaded() {
  const h = setup(); h.seed('a'); await h.ctx.activate('a'); assert.equal(h.errors.length, 0); return h;
}

test('file picker has one native keyboard button and invokes the existing hidden input', async () => {
  const h = await loaded(), before = h.ctx.csv();
  const button = h.D('choose-file'); nativeButton(button, 'picker');
  assert.match(html, /<button\b[^>]*id="choose-file"[^>]*>Choose Parquet files<\/button>/);
  button.focus(); button.click();
  assert.equal(h.clicks.filter(id => id === 'file').length, 1);
  assert.equal(h.ctx.csv(), before, 'opening/cancelling does not discard the current data');
  assert.equal(h.document.activeElement, button);
  assert.match(html, /input\[type="file"\]\s*\{\s*display:\s*none/);
});

test('every header has a native sort button, a useful escaped name, and aria-sort', async () => {
  const h = setup(), column = '東京 "x" <tag> & count';
  h.seed('a', [{ [column]: 2, other: 1 }]); await h.ctx.activate('a');
  for (const name of [column, 'other']) {
    const button = h.sort(name); nativeButton(button, name);
    assert.match(button.getAttribute('aria-label'), /sort ascending/);
    assert(button.getAttribute('aria-label').includes(name));
    assert.equal(h.header(name).getAttribute('aria-sort'), 'none');
  }
  assert.equal(h.D('data-head').querySelector('tag'), null, 'column text remains escaped');
});

test('sort button click bubbles exactly once and repeated cycles retain the replaced button focus', async () => {
  const h = await loaded();
  const original = h.ctx.csv();
  for (const [state, values, action] of [['ascending', [1, 2], 'sort descending'], ['descending', [2, 1], 'reset sort'], ['none', [2, 1], 'sort ascending']]) {
    const previous = h.sort('value'); nativeButton(previous, 'sort'); previous.focus(); previous.click();
    assert.equal(h.header('value').getAttribute('aria-sort'), state);
    assert.deepEqual(Array.from(h.ctx.visibleRows(), row => row.value), values);
    assert.match(h.sort('value').getAttribute('aria-label'), new RegExp(action));
    assert.notEqual(h.sort('value'), previous, 'the actual render replaces the node');
    assert.equal(h.document.activeElement, h.sort('value'), 'focus continues on the new same-column button');
  }
  assert.equal(h.ctx.csv(), original);
  assert.equal(h.reads.length, 0);
});

test('pointer header activation does not steal focus from Find', async () => {
  const h = await loaded(); h.D('find-query').focus();
  h.header('value').click();
  assert.equal(h.ctx.N.sortDirection, 1); assert.equal(h.ctx.N.sortColumn, 'value');
  assert.equal(h.document.activeElement, h.D('find-query'));
});

test('stale sort callbacks cannot change a newer tab, page, or focus owner', async () => {
  const h = await loaded(), stale = h.header('value');
  h.seed('b', [{ value: 9 }]); await h.ctx.activate('b'); h.D('find-query').focus();
  stale.onclick(); assert.equal(h.ctx.N.sortColumn, null); assert.equal(h.document.activeElement, h.D('find-query'));
  const previousPage = h.header('value');
  h.run('N.completedPage = {...N.completedPage}'); previousPage.onclick();
  assert.equal(h.ctx.N.sortColumn, null); assert.equal(h.document.activeElement, h.D('find-query'));
});

test('file tab and named close button are siblings, never nested interactive controls', async () => {
  const h = setup(), name = '長い "filename" <img>.parquet'; h.seed('a', [], name); await h.ctx.activate('a');
  const tab = h.tab('a'), close = h.close('a'); nativeButton(tab, 'file tab'); nativeButton(close, 'close');
  assert.equal(tab.getAttribute('role'), 'tab'); assert.equal(tab.getAttribute('aria-selected'), 'true');
  assert.equal(close.getAttribute('aria-label'), 'Close ' + name);
  assert.equal(tab.contains(close), false); assert.equal(tab.parentElement, close.parentElement);
  assert.equal(h.D('tabs').querySelector('img'), null, 'filename remains escaped');
});

test('activating a different file preserves its tab focus synchronously across rerender', async () => {
  const h = await loaded(); h.seed('b'); h.ctx.renderTabs();
  h.tab('b').focus(); const prior = h.tab('b'); await prior.click();
  assert.equal(h.run('activeTab'), 'b'); assert.notEqual(h.tab('b'), prior);
  assert.equal(h.document.activeElement, h.tab('b'));
});

test('closing current file focuses the surviving current tab and keeps its CSV', async () => {
  const h = await loaded(); h.seed('b', [{ value: 7 }]); await h.ctx.activate('b');
  h.close('b').focus(); await h.close('b').click();
  assert.equal(h.run('activeTab'), 'a'); assert.equal(h.document.activeElement, h.tab('a'));
  assert.equal(h.ctx.csv(), '"value"\r\n"2"\r\n"1"'); assert.equal(h.close('b'), undefined);
});

test('closing background file keeps current data/selection and returns focus to that current tab', async () => {
  const h = await loaded(); h.seed('b'); h.ctx.renderTabs(); const before = h.ctx.csv(), session = h.ctx.N;
  h.close('b').focus(); await h.close('b').click();
  assert.equal(h.run('activeTab'), 'a'); assert.equal(h.ctx.N, session); assert.equal(h.ctx.csv(), before);
  assert.equal(h.document.activeElement, h.tab('a')); assert.equal(h.reads.length, 0);
});

test('closing last file returns owned focus to picker and disables exports', async () => {
  const h = await loaded(); h.close('a').focus(); await h.close('a').click();
  assert.equal(h.run('tabs.size'), 0); assert.equal(h.document.activeElement, h.D('choose-file'));
  assert.equal(h.ctx.csv(), ''); assert.equal(h.D('download-csv').disabled, true); assert.equal(h.D('copy-csv').disabled, true);
});

test('tab rerenders preserve a surviving close button but never take unrelated focus', async () => {
  const h = await loaded(); h.seed('b'); h.ctx.renderTabs();
  h.close('a').focus(); const prior = h.close('a'); await h.close('b').click();
  assert.notEqual(h.close('a'), prior); assert.equal(h.document.activeElement, h.close('a'));
  h.D('find-query').focus(); h.ctx.renderTabs(); assert.equal(h.document.activeElement, h.D('find-query'));
});

test('closing into an unread tab restores focus before await and completion respects newer focus', async () => {
  const h = setup(); h.seed('a', [{ value: 1 }], 'a.parquet', false); h.seed('b'); await h.ctx.activate('b');
  h.close('b').focus(); const closing = h.close('b').click();
  assert.equal(h.reads.length, 1); assert.equal(h.document.activeElement, h.tab('a'), 'restore before the pending page read');
  h.D('choose-file').focus(); h.reads[0].resolve([{ value: 1 }]); await closing;
  assert.equal(h.document.activeElement, h.D('choose-file')); assert.equal(h.run('activeTab'), 'a');
});

test('late close/read continuation cannot replace a newer tab intent or its close focus', async () => {
  const h = setup(); h.seed('a', [{ value: 1 }], 'a.parquet', false); h.seed('b'); h.seed('c', [{ value: 3 }]); await h.ctx.activate('b');
  h.close('b').focus(); const closing = h.close('b').click();
  h.tab('c').focus(); await h.tab('c').click(); h.close('c').focus();
  h.reads[0].resolve([{ value: 1 }]); await closing;
  assert.equal(h.run('activeTab'), 'c'); assert.equal(h.ctx.csv(), '"value"\r\n"3"'); assert.equal(h.document.activeElement, h.close('c'));
});
