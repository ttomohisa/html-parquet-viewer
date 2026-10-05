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
  const elements = new Map(), reads = [], metadataReads = [], downloads = [], blobs = [], copied = [], timers = [];
  function element(id = '') {
    return { id, innerHTML: '', textContent: '', hidden: false, disabled: false, value: '', dataset: {}, style: {},
      classList: { add() {}, remove() {} }, addEventListener() {}, setAttribute() {}, remove() {},
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
    run(`tabs.set(${JSON.stringify(id)}, input)`);
  }
  const close = id => D('tabs').onclick({ target: { closest: selector => selector === '[data-close]' ? { dataset: { close: id } } : null } });
  const switchTab = id => D('tabs').onclick({ target: { closest: selector => selector === '[data-tab]' ? { dataset: { tab: id } } : null } });
  const snapshot = () => JSON.stringify([...elements].filter(([id]) => id !== 'tabs').map(([id, e]) => [id, e.innerHTML, e.textContent, e.className, e.hidden, e.disabled, e.value]));
  return { ctx, run, D, reads, metadataReads, downloads, blobs, copied, timers, seed, close, switchTab, snapshot };
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


async function sortFixture(values) {
  const h = setup(); h.seed('a', 'synthetic-signed-int64', values.length);
  h.run("tabs.get('a').pageSize = " + values.length);
  await loaded(h, 'a', values.map(value => ({ value })));
  const click = () => h.D('data-head').headers.find(th => th.dataset.column === 'value').onclick();
  return { h, click, values: () => Array.from(h.ctx.visibleRows(), row => row.value) };
}
test('REPRO signed BigInt ascending order is numeric', async () => {
  const f = await sortFixture([-2n, -10n, 0n, 2n, 10n]);
  f.click();
  assert.deepEqual(f.values(), [-10n, -2n, 0n, 2n, 10n]);
});
test('REPRO signed BigInt descending order is numeric', async () => {
  const f = await sortFixture([-2n, -10n, 0n, 2n, 10n]);
  f.click(); f.click();
  assert.deepEqual(f.values(), [10n, 2n, 0n, -2n, -10n]);
});
test('CONTROL signed Number ascending and descending already work', async () => {
  const f = await sortFixture([-2, -10, 0, 2, 10]);
  f.click(); assert.deepEqual(f.values(), [-10, -2, 0, 2, 10]);
  f.click(); assert.deepEqual(f.values(), [10, 2, 0, -2, -10]);
});
test('CONTROL positive BigInt values beyond MAX_SAFE_INTEGER remain distinct', async () => {
  const f = await sortFixture([9223372036854775807n, 9007199254740993n, 9007199254740992n]);
  f.click(); assert.deepEqual(f.values(), [9007199254740992n, 9007199254740993n, 9223372036854775807n]);
  assert.equal(f.h.ctx.csv(), '"value"\r\n"9007199254740992"\r\n"9007199254740993"\r\n"9223372036854775807"');
});
test('CONTROL third click restores original BigInt order and leaves raw rows untouched', async () => {
  const original = [-2n, -10n, 0n, 2n, 10n];
  const f = await sortFixture(original);
  f.click(); f.click(); f.click();
  assert.deepEqual(f.values(), original);
  assert.deepEqual(Array.from(f.h.ctx.N.completedPage.rows, row => row.value), original);
  assert.deepEqual(Array.from(f.h.ctx.N.lastRows, row => typeof row.value), original.map(() => 'bigint'));
});
test('CONTROL null placement follows the existing direction policy', async () => {
  const f = await sortFixture([null, 2n, undefined, 1n]);
  f.click(); assert.deepEqual(f.values(), [1n, 2n, null, undefined]);
  f.click(); assert.deepEqual(f.values(), [null, undefined, 2n, 1n]);
});
test('CONTROL strings keep natural string ordering', async () => {
  const f = await sortFixture(['item10', 'item2', 'Item1']);
  f.click(); assert.deepEqual(f.values(), ['Item1', 'item2', 'item10']);
});
test('CONTROL binary, null, empty, quoting and BigInt display/CSV remain as shipped', async () => {
  const h = setup(); h.seed('a', 'synthetic-format');
  await loaded(h, 'a', [{ big: -9223372036854775808n, absent: null, empty: '', bytes: new Uint8Array([0, 255]), quoted: 'x,"y"\nz' }]);
  assert.equal(h.ctx.csv(), '"big","absent","empty","bytes","quoted"\r\n"-9223372036854775808","","","Uint8Array(2) 00ff","x,""y""\nz"');
  assert.match(h.D('data-body').innerHTML, /class="null-value"/);
  assert.match(h.D('data-body').innerHTML, /class="empty-value"/);
});

test('signed INT64 extremes and adjacent unsafe BigInts sort exactly', async () => {
  const original = [-9007199254740992n, -9007199254740993n, -9223372036854775808n, 9223372036854775807n, 9007199254740993n, 0n];
  const expected = [-9223372036854775808n, -9007199254740993n, -9007199254740992n, 0n, 9007199254740993n, 9223372036854775807n];
  const f = await sortFixture(original);
  f.click(); assert.deepEqual(f.values(), expected);
  f.click(); assert.deepEqual(f.values(), [...expected].reverse());
  f.click(); assert.deepEqual(f.values(), original);
});
test('BigInt equality and existing mixed-type comparison policy stay intact', () => {
  const h = setup();
  assert.equal(h.ctx.compareValues(-9007199254740993n, -9007199254740993n), 0);
  for (const [a, b] of [[-10n, '-2'], [-10n, -2], [2n, 'item10']]) {
    assert.equal(h.ctx.compareValues(a, b), String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: 'base' }));
  }
});
