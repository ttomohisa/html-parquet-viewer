const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test: nodeTest } = require('node:test');
const test = (name, fn) => nodeTest(name, { timeout: 2000 }, fn);

// Exercise the shipped application's actual functions. DOM, parser boundaries and
// downloads are test doubles: these checks do not parse real Parquet or use a browser.
const html = fs.readFileSync(process.env.PARQUET_HTML || path.join(__dirname, '..', 'parquet-viewer.html'), 'utf8');
const start = html.indexOf('var D = e => document.getElementById(e)');
assert(start > 0, 'standalone application entry point exists');
const app = html.slice(start, html.indexOf('</script>', start));
const tick = () => new Promise(setImmediate);
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function setup() {
  const elements = new Map(), reads = [], metadataReads = [], downloads = [], blobs = [], copied = [], timers = [], scrolls = [];
  function element(id = '') {
    return { id, innerHTML: '', textContent: '', hidden: false, disabled: false, value: '', dataset: {}, style: {},
      classList: { add() {}, remove() {} }, addEventListener() {}, setAttribute() {}, remove() {},
      focus() {},
      querySelector(selector) { return this.innerHTML.includes('data-find-current="true"') ? { scrollIntoView: options => scrolls.push({ selector, options }) } : null; },
      click() { downloads.push(this.download); },
      querySelectorAll(selector) {
        this.headers = selector === 'th[data-column]' ? [...this.innerHTML.matchAll(/data-column="([^"]*)"/g)].map(m => ({ dataset: { column: m[1] } })) : [];
        return this.headers;
      }
    };
  }
  const D = id => { if (!elements.has(id)) elements.set(id, element(id)); return elements.get(id); };
  const ctx = vm.createContext({
    console: { error() {} }, document: { getElementById: D, querySelectorAll: () => [], createElement: () => element(), body: { append() {} } },
    navigator: { clipboard: { writeText: async text => { copied.push(text); } } }, window: { isSecureContext: true },
    Uint8Array, Date, Blob, setTimeout: callback => { timers.push(callback); return timers.length; },
    URL: { createObjectURL: blob => { blobs.push(blob); return 'blob:synthetic'; }, revokeObjectURL() {} }, hn: {},
    Jt: options => { const d = deferred(); reads.push({ options, ...d }); return d.promise; },
    Oe: file => { const d = deferred(); metadataReads.push({ file, ...d }); return d.promise; },
    J: () => ({ children: [{ element: { name: 'name', type: 'BYTE_ARRAY', converted_type: 'UTF8' }, children: [] }] })
  });
  vm.runInContext(app, ctx, { filename: 'shipped-parquet-app.js' });
  const run = code => vm.runInContext(code, ctx);
  function seed(id, name, rows = 2) {
    ctx.input = { file: { name: name + '.parquet', size: 32 }, metadata: { num_rows: rows, version: 1, row_groups: [] },
      schema: ctx.J(), page: 0, pageSize: 1, rows, lastRows: [], lastColumns: [], sortColumn: null, sortDirection: 1,
      request: 0, loading: false, completedPage: null, statusText: '', statusClass: '' };
    run(`tabs.set(${JSON.stringify(id)}, Object.assign(emptySession(), input))`);
  }
  const close = id => D('tabs').onclick({ target: { closest: selector => selector === '[data-close]' ? { dataset: { close: id } } : null } });
  const switchTab = id => D('tabs').onclick({ target: { closest: selector => selector === '[data-tab]' ? { dataset: { tab: id } } : null } });
  const snapshot = () => JSON.stringify([...elements].filter(([id]) => id !== 'tabs').map(([id, e]) => [id, e.innerHTML, e.textContent, e.className, e.hidden, e.disabled, e.value]));
  return { ctx, run, D, reads, metadataReads, downloads, blobs, copied, timers, scrolls, seed, close, switchTab, snapshot };
}
async function loaded(h, id, rows) {
  const p = h.ctx.activate(id);
  h.reads.at(-1).resolve(rows);
  await p;
}
const fakeFile = name => ({ name: name + '.parquet', size: 32, slice: () => ({ arrayBuffer: async () => new Uint8Array([80, 65, 82, 49]).buffer }) });
const metadata = (name, rows) => ({ num_rows: rows, version: 1, row_groups: [], created_by: name + ' maker' });
const assertExportsDisabled = h => {
  assert.equal(h.D('copy-csv').disabled, true);
  assert.equal(h.D('download-csv').disabled, true);
};

const find = (h, query) => { h.D('find-query').value = query; h.D('find-query').oninput({ target: h.D('find-query') }); };
const count = h => h.D('find-count').textContent;
const matches = h => (h.D('data-body').innerHTML.match(/class="find-match/g) || []).length;
const current = h => Number(h.D('data-body').innerHTML.match(/data-find-row="(\d+)" data-find-current="true"/)?.[1] ?? -1);
const assertFindDisabled = h => {
  assert.equal(h.D('find-query').disabled, true);
  assert.equal(h.D('find-prev').disabled, true);
  assert.equal(h.D('find-next').disabled, true);
  assert.equal(count(h), ''); assert.equal(matches(h), 0);
};
const key = (h, value, shiftKey = false) => { let prevented = false; h.D('find-query').onkeydown({ key: value, shiftKey, preventDefault() { prevented = true; } }); return prevented; };

test('find markup labels the input, live count and current-page/binary limitations', () => {
  assert.match(html, /<label for="find-query">Find values on this page<\/label>/);
  assert.match(html, /id="find-query"[^>]*aria-describedby="find-help find-count"/);
  assert.match(html, /id="find-count"[^>]*role="status"[^>]*aria-live="polite"/);
  assert.match(html, /Binary values include only their displayed summary \(first 24 bytes\)/);
});
test('find is unavailable before a completed page exists', () => assertFindDisabled(setup()));
test('literal case-insensitive finding highlights matching rows, without filtering or rereading', async () => {
  const h = setup(); h.seed('a', 'values', 4);
  await loaded(h, 'a', [{ value: 'PEAR', other: 'pear' }, { value: 'apple' }, { value: 'pEaR tart' }, { value: 'pineapple' }]);
  const csv = h.ctx.csv(), reads = h.reads.length;
  find(h, 'pEaR'); assert.equal(count(h), '1 of 2 matching rows on this page');
  assert.equal(matches(h), 2); assert.equal(current(h), 0);
  assert.equal((h.D('data-body').innerHTML.match(/<tr/g) || []).length, 4);
  assert.equal(h.ctx.csv(), csv); assert.equal(h.reads.length, reads);
  h.D('find-next').onclick(); assert.equal(current(h), 2); assert.equal(count(h), '2 of 2 matching rows on this page');
  h.D('find-next').onclick(); assert.equal(current(h), 0);
  h.D('find-prev').onclick(); assert.equal(current(h), 2);
  assert.equal(h.scrolls.length, 4);
});
test('Enter and Shift+Enter navigate, Escape and Clear remove results', async () => {
  const h = setup(); h.seed('a', 'keys'); await loaded(h, 'a', [{ value: 'a' }, { value: 'a' }]);
  find(h, 'a'); assert.equal(key(h, 'Enter'), true); assert.equal(current(h), 1);
  key(h, 'Enter', true); assert.equal(current(h), 0);
  assert.equal(key(h, 'Escape'), true); assert.equal(h.D('find-query').value, ''); assert.equal(matches(h), 0); assert.equal(count(h), '');
  find(h, 'a'); h.D('find-clear').onclick(); assert.equal(h.D('find-query').value, ''); assert.equal(matches(h), 0);
  assert.equal(h.D('find-next').disabled, true); assert.equal(h.D('find-clear').disabled, true);
});
test('no matches and empty query disable navigation, while whitespace stays literal', async () => {
  const h = setup(); h.seed('a', 'empty'); await loaded(h, 'a', [{ value: 'two words' }, { value: '' }]);
  find(h, 'missing'); assert.equal(count(h), '0 matching rows on this page'); assert.equal(matches(h), 0);
  assert.equal(h.D('find-prev').disabled, true); assert.equal(h.D('find-next').disabled, true);
  h.D('find-next').onclick(); assert.equal(current(h), -1);
  find(h, ' '); assert.equal(matches(h), 1);
  find(h, ''); assert.equal(count(h), ''); assert.equal(matches(h), 0);
});
test('literal Unicode, regex punctuation and HTML-like values stay escaped', async () => {
  const h = setup(); h.seed('a', 'text'); await loaded(h, 'a', [{ value: 'CAFÉ 東京 .* [x] <img src=x> "quoted" & more' }, { value: 'not a match' }]);
  for (const query of ['café', '東京', '.*', '[x]', '<img', '"quoted"', '& more']) { find(h, query); assert.equal(matches(h), 1, query); }
  assert.doesNotMatch(h.D('data-body').innerHTML, /<img/); assert.match(h.D('data-body').innerHTML, /&lt;img/);
  find(h, '<script>'); assert.equal(matches(h), 0); assert.doesNotMatch(h.D('data-body').innerHTML, /<script>/);
});
test('finding uses displayed null, date, BigInt, object and binary summary values only', async () => {
  const h = setup(); h.seed('a', 'format'); const bytes = new Uint8Array(25); bytes[24] = 255;
  await loaded(h, 'a', [{ value: null }, { value: undefined }, { value: '' }, { value: -9223372036854775808n }, { value: new Date('2026-01-02T03:04:05Z') }, { value: { nested: 99n } }, { value: bytes }]);
  find(h, 'null'); assert.equal(matches(h), 2, 'null and undefined markers match, empty strings do not');
  for (const query of ['-9223372036854775808', '2026-01-02T03:04:05.000Z', '"nested":"99"', 'Uint8Array(25)', '000000', '…']) { find(h, query); assert.equal(matches(h), 1, query); }
  find(h, 'ff'); assert.equal(matches(h), 0, 'undisplayed 25th byte is excluded');
  find(h, 'value'); assert.equal(matches(h), 0, 'column headings are excluded');
});
test('query and current match remain per-tab, and closing never transfers them', async () => {
  const h = setup(); h.seed('a', 'a'); h.seed('b', 'b');
  await loaded(h, 'a', [{ v: 'a' }, { v: 'a' }]); find(h, 'a'); h.D('find-next').onclick();
  await loaded(h, 'b', [{ v: 'b' }]); assert.equal(h.D('find-query').value, ''); find(h, 'b');
  const reads = h.reads.length; await h.switchTab('a'); assert.equal(h.D('find-query').value, 'a'); assert.equal(current(h), 1); assert.equal(h.reads.length, reads);
  await h.close('a'); assert.equal(h.D('find-query').value, 'b'); assert.equal(matches(h), 1);
  await h.close('b'); assertFindDisabled(h); assert.equal(h.D('find-query').value, '');
});
test('loading and failure clear results but retry uses the same query on the new completed page', async () => {
  const h = setup(); h.seed('a', 'a', 3); await loaded(h, 'a', [{ v: 'a' }, { v: 'a' }]); find(h, 'a'); h.D('find-next').onclick();
  const next = h.D('next').onclick(); assertFindDisabled(h); assert.equal(h.D('find-query').value, 'a');
  h.reads.at(-1).reject(new Error('read failed')); await next; assertFindDisabled(h);
  const retry = h.D('row-jump').onchange({ target: { value: '2' } }); h.reads.at(-1).resolve([{ v: 'a2' }, { v: 'a3' }]); await retry;
  assert.equal(matches(h), 2); assert.equal(current(h), 0); assert.equal(h.D('find-query').value, 'a');
});
test('sorting resets match position in sorted order without changing query or raw rows', async () => {
  const h = setup(); h.seed('a', 'sort'); const rows = [{ v: 'a2' }, { v: 'a1' }]; await loaded(h, 'a', rows); find(h, 'a'); h.D('find-next').onclick();
  h.D('data-head').headers[0].onclick(); assert.equal(current(h), 0); assert.equal(h.D('find-query').value, 'a');
  assert.equal(h.ctx.csv(), '"v"\r\n"a1"\r\n"a2"'); assert.equal(h.ctx.N.completedPage.rows, rows);
  h.D('find-next').onclick(); h.D('data-head').headers[0].onclick(); assert.equal(current(h), 0);
  h.D('find-next').onclick(); h.D('data-head').headers[0].onclick(); assert.equal(current(h), 0); assert.equal(h.reads.length, 1);
});
test('background completion, failure and closed requests cannot change active find state', async () => {
  for (const fail of [false, true]) {
    const h = setup(); h.seed('a', 'a'); h.seed('b', 'b');
    await loaded(h, 'a', [{ v: 'a' }]); find(h, 'a'); const pending = h.D('next').onclick(); const read = h.reads.at(-1);
    await loaded(h, 'b', [{ v: 'b' }]); find(h, 'b'); const before = h.snapshot();
    if (fail) read.reject(new Error('late')); else read.resolve([{ v: 'a' }]); await pending;
    assert.equal(h.snapshot(), before);
    const again = h.ctx.yt(h.run("tabs.get('a')"), 'a'); const closedRead = h.reads.at(-1); await h.close('a');
    closedRead.resolve([{ v: 'a' }]); await again; assert.equal(h.snapshot(), before);
  }
});
test('overlapping page reads and page-size changes only expose newest find results', async () => {
  const h = setup(); h.seed('a', 'a', 100); await loaded(h, 'a', [{ v: 'a' }]); find(h, 'a');
  const old = h.D('next').onclick(), oldRead = h.reads.at(-1);
  const newest = h.D('page-size').onchange({ target: { value: '50' } });
  h.reads.at(-1).resolve([{ v: 'a1' }, { v: 'a2' }]); await newest;
  const before = h.snapshot(); oldRead.resolve([{ v: 'not found' }]); await old; assert.equal(h.snapshot(), before); assert.equal(matches(h), 2); assert.equal(current(h), 0);
});
test('searching leaves CSV copy and download bytes, name and read count unchanged', async () => {
  const h = setup(); h.seed('a', 'csv'); await loaded(h, 'a', [{ v: '"pear"\n', n: 9007199254740993n }, { v: null, n: 0n }]);
  const csv = h.ctx.csv(), reads = h.reads.length; find(h, 'pear'); h.ctx.downloadCsv(); await h.D('copy-csv').onclick();
  assert.equal(h.ctx.csv(), csv); assert.equal(await h.blobs[0].text(), csv); assert.equal(h.copied[0], csv); assert.equal(h.downloads[0], 'csv-page-1.csv'); assert.equal(h.reads.length, reads);
});
test('empty page produces no matching rows and never enables match navigation', async () => {
  const h = setup(); h.seed('a', 'a'); await loaded(h, 'a', [{ v: 'a' }]); find(h, 'a');
  const p = h.D('next').onclick(); h.reads.at(-1).resolve([]); await p;
  assert.equal(matches(h), 0); assert.equal(count(h), '0 matching rows on this page'); assert.equal(h.D('find-next').disabled, true);
});
test('stale find controls and header callbacks cannot mutate a different active page', async () => {
  const h = setup(); h.seed('a', 'a'); h.seed('b', 'b'); await loaded(h, 'a', [{ v: 'a' }]); find(h, 'a');
  const staleHeader = h.D('data-head').headers[0].onclick;
  await loaded(h, 'b', [{ v: 'b' }]); find(h, 'b'); const before = h.snapshot(); staleHeader(); assert.equal(h.snapshot(), before);
});
test('IME composition confirmation and cancellation do not trigger find shortcuts', async () => {
  const h = setup(); h.seed('a', 'ime'); await loaded(h, 'a', [{ v: '東京' }, { v: '東京' }]); find(h, '東京');
  for (const composition of [{ isComposing: true }, { keyCode: 229 }]) {
    for (const key of ['Enter', 'Escape']) {
      let prevented = false;
      h.D('find-query').onkeydown({ key, ...composition, preventDefault() { prevented = true; } });
      assert.equal(prevented, false, `${key} stays available to the IME`);
      assert.equal(h.D('find-query').value, '東京'); assert.equal(current(h), 0); assert.equal(matches(h), 2);
    }
  }
});
