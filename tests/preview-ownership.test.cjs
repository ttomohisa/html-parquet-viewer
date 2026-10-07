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

test('successful range read, CSV download and copy preserve visible values', async () => {
  const h = setup(); h.seed('a', 'orchard');
  await loaded(h, 'a', [{ name: 'pear' }]);
  assert.equal(h.reads[0].options.file.name, 'orchard.parquet');
  assert.equal(h.reads[0].options.rowStart, 0); assert.equal(h.reads[0].options.rowEnd, 1);
  assert.equal(h.ctx.csv(), '"name"\r\n"pear"');
  assert.equal(h.D('page-label').textContent, 'Page 1 of 2');
  assert.equal(h.D('prev').disabled, true); assert.equal(h.D('next').disabled, false);
  h.ctx.downloadCsv();
  assert.equal(h.downloads.at(-1), 'orchard-page-1.csv');
  assert.equal(await h.blobs.at(-1).text(), '"name"\r\n"pear"');
  await h.D('copy-csv').onclick(); assert.equal(h.copied.at(-1), h.ctx.csv());
});

test('failed next page clears stale exports and can retry the requested page', async () => {
  const h = setup(); h.seed('a', 'orchard');
  await loaded(h, 'a', [{ name: 'pear' }]);
  const pending = h.D('next').onclick(); assertExportsDisabled(h);
  h.reads.at(-1).reject(new Error('ordinary preview read failure')); await pending;
  assertExportsDisabled(h); assert.equal(h.ctx.csv(), '');
  h.ctx.downloadCsv(); await h.D('copy-csv').onclick();
  assert.equal(h.downloads.length, 0); assert.equal(h.copied.length, 0);
  assert.equal(h.D('status').className, 'error');
  assert.doesNotMatch(h.D('data-body').innerHTML, /pear/);
  const retry = h.D('row-jump').onchange({ target: { value: '2' } });
  assert.equal(h.reads.at(-1).options.rowStart, 1);
  h.reads.at(-1).resolve([{ name: 'apple' }]); await retry;
  h.ctx.downloadCsv(); assert.equal(h.downloads.at(-1), 'orchard-page-2.csv');
  assert.equal(h.ctx.csv(), '"name"\r\n"apple"');
  assert.equal(h.D('next').disabled, true); assert.equal(h.D('prev').disabled, false);
});

test('late A completion cannot overwrite active B preview or its saved tab', async () => {
  const h = setup(); h.seed('a', 'orchard'); h.seed('b', 'meadow');
  const a = h.ctx.activate('a'), readA = h.reads.at(-1);
  await loaded(h, 'b', [{ name: 'clover' }]); const before = h.snapshot();
  readA.resolve([{ name: 'pear' }]); await a;
  assert.equal(h.snapshot(), before); assert.equal(h.ctx.csv(), '"name"\r\n"clover"');
  assert.equal(h.run("tabs.get('b').lastRows[0].name"), 'clover');
  h.ctx.downloadCsv(); assert.equal(h.downloads.at(-1), 'meadow-page-1.csv');
});

test('old completion cannot enable controls while B is loading', async () => {
  const h = setup(); h.seed('a', 'orchard'); h.seed('b', 'meadow');
  const a = h.ctx.activate('a'), readA = h.reads.at(-1);
  const b = h.ctx.activate('b'), readB = h.reads.at(-1), before = h.snapshot();
  readA.resolve([{ name: 'pear' }]); await a;
  assert.equal(h.snapshot(), before); assertExportsDisabled(h);
  for (const id of ['prev', 'next', 'page-size', 'row-jump']) assert.equal(h.D(id).disabled, true, id);
  readB.resolve([{ name: 'clover' }]); await b;
});

test('closing the final tab prevents pending page completion from repopulating it', async () => {
  const h = setup(); h.seed('a', 'orchard');
  const a = h.ctx.activate('a'), read = h.reads.at(-1);
  await h.close('a'); const before = h.snapshot();
  read.resolve([{ name: 'pear' }]); await a;
  assert.equal(h.snapshot(), before); assert.equal(h.run('tabs.size'), 0);
  assert.equal(h.ctx.N.file, null); assert.equal(h.ctx.N.lastRows.length, 0);
  assert.equal(h.D('pager').hidden, true); assertExportsDisabled(h);
});

test('late metadata remains attached to its own tab and row range', async () => {
  const h = setup();
  const a = h.ctx.openOne(fakeFile('orchard')); await tick(); const metaA = h.metadataReads.at(-1);
  const b = h.ctx.openOne(fakeFile('meadow')); await tick(); const metaB = h.metadataReads.at(-1);
  metaB.resolve(metadata('meadow', 3)); await tick(); h.reads.at(-1).resolve([{ name: 'clover' }]); await b;
  const before = h.snapshot();
  metaA.resolve(metadata('orchard', 2)); await tick();
  assert.equal(h.ctx.N.metadata.created_by, 'meadow maker'); assert.equal(h.ctx.N.rows, 3);
  assert.equal(h.reads.at(-1).options.file.name, 'orchard.parquet');
  assert.equal(h.reads.at(-1).options.rowEnd, 2);
  h.reads.at(-1).resolve([{ name: 'pear' }]); await a;
  assert.equal(h.snapshot(), before);
  await h.switchTab(h.run("[...tabs.keys()].find(id => tabs.get(id).file.name === 'orchard.parquet')"));
  assert.equal(h.ctx.N.metadata.created_by, 'orchard maker'); assert.equal(h.ctx.csv(), '"name"\r\n"pear"');
});

test('late background page failure cannot replace B status or controls', async () => {
  const h = setup(); h.seed('a', 'orchard'); h.seed('b', 'meadow');
  const a = h.ctx.activate('a'), readA = h.reads.at(-1);
  await loaded(h, 'b', [{ name: 'clover' }]); const before = h.snapshot();
  readA.reject(new Error('ordinary preview read failure')); await a;
  assert.equal(h.snapshot(), before); assert.equal(h.ctx.csv(), '"name"\r\n"clover"');
});

test('same-tab overlapping page requests commit only the newest completion', async () => {
  const h = setup(); h.seed('a', 'orchard', 3);
  const first = h.ctx.activate('a'), old = h.reads.at(-1);
  h.ctx.N.page = 1; const second = h.ctx.yt(), newest = h.reads.at(-1);
  newest.resolve([{ name: 'apple' }]); await second; const before = h.snapshot();
  old.resolve([{ name: 'pear' }]); await first;
  assert.equal(h.snapshot(), before); assert.equal(h.ctx.csv(), '"name"\r\n"apple"');
  h.ctx.downloadCsv(); assert.equal(h.downloads.at(-1), 'orchard-page-2.csv');
});

test('same-tab superseded failure does not unlock or error the newer pending read', async () => {
  const h = setup(); h.seed('a', 'orchard', 3);
  const first = h.ctx.activate('a'), old = h.reads.at(-1);
  h.ctx.N.page = 1; const second = h.ctx.yt(), newest = h.reads.at(-1), before = h.snapshot();
  old.reject(new Error('ordinary preview read failure')); await first;
  assert.equal(h.snapshot(), before); assertExportsDisabled(h);
  newest.resolve([{ name: 'apple' }]); await second;
});

test('returning to a completed tab restores its sorted page without another read', async () => {
  const h = setup(); h.seed('a', 'orchard'); h.seed('b', 'meadow');
  await loaded(h, 'a', [{ name: 'pear', quantity: 2 }, { name: 'apple', quantity: 1 }]);
  const sort = () => h.D('data-head').headers.find(th => th.dataset.column === 'quantity').onclick();
  sort(); assert.equal(h.ctx.csv(), '"name","quantity"\r\n"apple","1"\r\n"pear","2"');
  const table = h.D('data-body').innerHTML;
  await loaded(h, 'b', [{ name: 'clover' }]);
  const count = h.reads.length; const returned = h.switchTab('a');
  assert.equal(h.reads.length, count, 'completed snapshots do not start another parser read'); await returned;
  assert.equal(h.D('data-body').innerHTML, table); assert.equal(h.ctx.N.sortDirection, 1);
  sort(); assert.equal(h.ctx.visibleRows()[0].name, 'pear');
  sort(); assert.equal(h.ctx.N.sortColumn, null); assert.equal(h.ctx.visibleRows()[0].name, 'pear');
});

test('switching back while metadata is pending keeps controls disabled until ready', async () => {
  const h = setup();
  const a = h.ctx.openOne(fakeFile('orchard')); await tick(); const meta = h.metadataReads.at(-1), id = h.run('activeTab');
  h.seed('b', 'meadow'); await loaded(h, 'b', [{ name: 'clover' }]);
  await h.switchTab(id); assertExportsDisabled(h); assert.equal(h.D('status').className, 'loading');
  meta.resolve(metadata('orchard', 2)); await tick(); h.reads.at(-1).resolve([{ name: 'pear' }]); await a;
  assert.equal(h.ctx.N.file.name, 'orchard.parquet'); assert.equal(h.ctx.csv(), '"name"\r\n"pear"');
});

test('close during metadata read ignores success and starts no page read', async () => {
  const h = setup(); const a = h.ctx.openOne(fakeFile('orchard')); await tick();
  await h.close(h.run('activeTab')); const before = h.snapshot();
  h.metadataReads.at(-1).resolve(metadata('orchard', 2)); await tick();
  assert.equal(h.reads.length, 0); await a; assert.equal(h.snapshot(), before); assert.equal(h.ctx.N.file, null);
});

test('closed background metadata failure cannot switch tabs or report an error', async () => {
  const h = setup(); const a = h.ctx.openOne(fakeFile('orchard')); await tick(); const id = h.run('activeTab');
  h.seed('b', 'meadow'); await loaded(h, 'b', [{ name: 'clover' }]);
  await h.close(id); const before = h.snapshot();
  h.metadataReads.at(-1).reject(new Error('invalid footer')); await tick();
  assert.equal(h.snapshot(), before); await a; assert.equal(h.run('activeTab'), 'b');
});

test('background metadata failure leaves the active completed tab untouched', async () => {
  const h = setup(); const a = h.ctx.openOne(fakeFile('orchard')); await tick();
  h.seed('b', 'meadow'); await loaded(h, 'b', [{ name: 'clover' }]); const before = h.snapshot();
  h.metadataReads.at(-1).reject(new Error('invalid footer')); await tick();
  assert.equal(h.snapshot(), before); await a; assert.equal(h.run('activeTab'), 'b');
});

test('empty previews keep exports disabled and navigation bounded', async () => {
  const h = setup(); h.seed('a', 'orchard', 0); await loaded(h, 'a', []);
  assertExportsDisabled(h); assert.equal(h.D('prev').disabled, true); assert.equal(h.D('next').disabled, true);
  assert.equal(h.D('page-label').textContent, 'Page 1 of 1');
  assert.match(h.D('data-body').innerHTML, /No rows/); h.ctx.downloadCsv(); assert.equal(h.downloads.length, 0);
});

test('page-size, jump and previous navigation request the selected range and export identity', async () => {
  const h = setup(); h.seed('a', 'orchard', 5); await loaded(h, 'a', [{ name: 'pear' }]);
  const resize = h.D('page-size').onchange({ target: { value: '2' } });
  assert.equal(h.reads.at(-1).options.rowEnd, 2); h.reads.at(-1).resolve([{ name: 'pear' }, { name: 'apple' }]); await resize;
  const jump = h.D('row-jump').onchange({ target: { value: '999' } });
  assert.equal(h.reads.at(-1).options.rowStart, 4); assert.equal(h.reads.at(-1).options.rowEnd, 5);
  h.reads.at(-1).resolve([{ name: 'plum' }]); await jump;
  h.ctx.downloadCsv(); assert.equal(h.downloads.at(-1), 'orchard-page-3.csv');
  const prev = h.D('prev').onclick(); assert.equal(h.reads.at(-1).options.rowStart, 2);
  h.reads.at(-1).resolve([{ name: 'peach' }]); await prev;
  assert.equal(h.D('page-label').textContent, 'Page 2 of 3');
});

test('copy feedback resets when the completed page changes', async () => {
  const h = setup(); h.seed('a', 'orchard');
  await loaded(h, 'a', [{ name: 'pear' }]);
  await h.D('copy-csv').onclick(); assert.equal(h.D('copy-csv').textContent, 'Copied');
  const next = h.D('next').onclick();
  assert.equal(h.D('copy-csv').textContent, 'Copy CSV');
  h.reads.at(-1).resolve([{ name: 'apple' }]); await next;
  assert.equal(h.D('copy-csv').textContent, 'Copy CSV');
});

test('late clipboard completion or failure cannot change another tab', async () => {
  for (const fail of [false, true]) {
    const h = setup(); h.seed('a', 'orchard'); h.seed('b', 'meadow');
    await loaded(h, 'a', [{ name: 'pear' }]);
    const copy = deferred(); h.ctx.navigator.clipboard.writeText = () => copy.promise;
    const pending = h.D('copy-csv').onclick();
    await loaded(h, 'b', [{ name: 'clover' }]); const before = h.snapshot();
    if (fail) copy.reject(new Error('clipboard unavailable')); else copy.resolve();
    await pending; assert.equal(h.snapshot(), before);
  }
});

test('active metadata failure stays on its own failed tab, then a new file can load', async () => {
  const h = setup(); const failed = h.ctx.openOne(fakeFile('orchard')); await tick();
  h.metadataReads.at(-1).reject(new Error('invalid footer')); await failed;
  assert.equal(h.ctx.N.file.name, 'orchard.parquet'); assert.equal(h.ctx.N.metadata, null);
  assert.equal(h.run('tabs.size'), 1);
  assert.equal(h.D('status').className, 'error'); assertExportsDisabled(h);
  for (const id of ['prev', 'next', 'page-size', 'row-jump']) assert.equal(h.D(id).disabled, true, id);
  const retry = h.ctx.openOne(fakeFile('meadow')); await tick();
  h.metadataReads.at(-1).resolve(metadata('meadow', 3)); await tick();
  h.reads.at(-1).resolve([{ name: 'clover' }]); await retry;
  assert.equal(h.ctx.N.file.name, 'meadow.parquet'); assert.equal(h.ctx.csv(), '"name"\r\n"clover"');
});

test('closing the active page request returns to the previous completed snapshot', async () => {
  const h = setup(); h.seed('a', 'orchard'); h.seed('b', 'meadow');
  await loaded(h, 'a', [{ name: 'pear' }]);
  const pending = h.ctx.activate('b'), read = h.reads.at(-1);
  await h.close('b'); const before = h.snapshot();
  read.reject(new Error('ordinary preview failure')); await pending;
  assert.equal(h.snapshot(), before); assert.equal(h.ctx.csv(), '"name"\r\n"pear"');
  assert.equal(h.reads.length, 2);
});


test('an active metadata failure remains visible without changing the completed tab', async () => {
  const h = setup(); h.seed('a', 'orchard'); await loaded(h, 'a', [{ name: 'pear' }]);
  const failed = h.ctx.openOne(fakeFile('meadow')); await tick(); const id = h.run('activeTab');
  h.metadataReads.at(-1).reject(new Error('invalid footer')); await failed;
  assert.equal(h.run('activeTab'), id); assert.equal(h.ctx.N.file.name, 'meadow.parquet');
  assert.equal(h.D('status').className, 'error'); assert.equal(h.D('status').textContent, 'This is not a Parquet file: missing PAR1 header.');
  assert.equal(h.ctx.N.metadata, null); assertExportsDisabled(h);
  assert.equal(h.run("tabs.get('a').lastRows[0].name"), 'pear');
  await h.close(id); assert.equal(h.ctx.csv(), '\"name\"\r\n\"pear\"');
});

test('an invalid file clears the previous summary, which returns only with its own tab', async () => {
  const h = setup(); h.seed('a', 'orchard', 257);
  h.run("tabs.get('a').metadata.row_groups = [{}, {}, {}, {}, {}]");
  await loaded(h, 'a', [{ name: 'pear' }]);
  const summary = h.D('summary').innerHTML, reads = h.reads.length;
  assert.match(summary, /orchard\.parquet/);
  assert.match(summary, /Rows<\/span><strong title="257">257<\/strong>/);
  assert.match(summary, /Row groups<\/span><strong title="5">5<\/strong>/);
  assert.equal(h.D('summary').hidden, false); assert.equal(h.D('pager').hidden, false);

  await h.ctx.openOne({ name: 'invalid.parquet', size: 32,
    slice: () => ({ arrayBuffer: async () => new Uint8Array([0, 0, 0, 0]).buffer }) });
  const failedId = h.run('activeTab');
  assert.equal(h.D('status').textContent, 'This is not a Parquet file: missing PAR1 header.');
  assert.equal(h.D('summary').hidden, true); assert.equal(h.D('pager').hidden, true);
  assert.equal(h.D('summary').innerHTML, '', 'failed tabs must not retain another file\'s facts');
  assertExportsDisabled(h); assert.equal(h.metadataReads.length, 0);

  await h.switchTab('a');
  assert.equal(h.D('summary').hidden, false); assert.equal(h.D('pager').hidden, false);
  assert.equal(h.D('summary').innerHTML, summary);
  assert.equal(h.ctx.csv(), '"name"\r\n"pear"');
  assert.equal(h.reads.length, reads, 'restoring a completed tab does not reread its page');
  await h.close(failedId); await h.close('a');
  assert.equal(h.run('tabs.size'), 0);
  assert.equal(h.D('summary').hidden, true); assert.equal(h.D('pager').hidden, true);
  assert.equal(h.D('summary').innerHTML, '', 'closing the final tab clears its facts');
  assertExportsDisabled(h);
});

test('pending metadata clears previous facts until the selected file is ready', async () => {
  const h = setup(); h.seed('a', 'orchard'); await loaded(h, 'a', [{ name: 'pear' }]);
  const summary = h.D('summary').innerHTML;
  const pending = h.ctx.openOne(fakeFile('meadow')); await tick();
  const id = h.run('activeTab'), meta = h.metadataReads.at(-1);
  assert.equal(h.D('status').className, 'loading');
  assert.equal(h.D('summary').hidden, true); assert.equal(h.D('pager').hidden, true);
  assert.equal(h.D('summary').innerHTML, '', 'pending metadata must not show the previous file');
  assertExportsDisabled(h);

  await h.switchTab('a'); assert.equal(h.D('summary').innerHTML, summary);
  await h.switchTab(id);
  assert.equal(h.D('summary').innerHTML, ''); assert.equal(h.D('summary').hidden, true);
  meta.resolve(metadata('meadow', 3)); await tick();
  h.reads.at(-1).resolve([{ name: 'clover' }]); await pending;
  assert.equal(h.D('summary').hidden, false); assert.equal(h.D('pager').hidden, false);
  assert.match(h.D('summary').innerHTML, /meadow\.parquet/);
  assert.doesNotMatch(h.D('summary').innerHTML, /orchard\.parquet/);
  assert.equal(h.ctx.csv(), '"name"\r\n"clover"');
});

test('a preview rendering failure clears the snapshot and reports a retryable error', async () => {
  const h = setup(); h.seed('a', 'orchard');
  await loaded(h, 'a', [{ name: new Date(NaN) }]);
  assert.equal(h.D('status').className, 'error'); assertExportsDisabled(h);
  assert.equal(h.ctx.N.completedPage, null); assert.equal(h.ctx.N.lastRows.length, 0);
  assert.equal(h.ctx.N.loading, false); assert.equal(h.D('page-size').disabled, false);
  const retry = h.D('row-jump').onchange({ target: { value: '1' } });
  h.reads.at(-1).resolve([{ name: 'pear' }]); await retry;
  assert.equal(h.ctx.csv(), '"name"\r\n"pear"');
});

test('a background snapshot rendering failure stays on that tab when activated', async () => {
  const h = setup(); h.seed('a', 'orchard'); h.seed('b', 'meadow');
  const a = h.ctx.activate('a'), old = h.reads.at(-1);
  await loaded(h, 'b', [{ name: 'clover' }]); const before = h.snapshot();
  old.resolve([{ name: new Date(NaN) }]); await a;
  assert.equal(h.snapshot(), before);
  await h.switchTab('a'); assert.equal(h.D('status').className, 'error'); assertExportsDisabled(h);
  await h.switchTab('b'); assert.equal(h.ctx.csv(), '"name"\r\n"clover"');
});

test('only the newest same-page clipboard operation may report its outcome', async () => {
  for (const olderFails of [false, true]) {
    const h = setup(); h.seed('a', 'orchard'); await loaded(h, 'a', [{ name: 'pear' }]);
    const old = deferred(), newest = deferred(); let calls = 0;
    h.ctx.navigator.clipboard.writeText = () => calls++ ? newest.promise : old.promise;
    const a = h.D('copy-csv').onclick(), b = h.D('copy-csv').onclick();
    newest.resolve(); await b; const before = h.snapshot();
    if (olderFails) old.reject(new Error('clipboard unavailable')); else old.resolve();
    await a; assert.equal(h.snapshot(), before);
  }
});


test('an older clipboard timer cannot clear newer same-page feedback', async () => {
  const h = setup(); h.seed('a', 'orchard'); await loaded(h, 'a', [{ name: 'pear' }]);
  await h.D('copy-csv').onclick(); const oldTimer = h.timers.at(-1);
  await h.D('copy-csv').onclick(); const newTimer = h.timers.at(-1);
  oldTimer(); assert.equal(h.D('copy-csv').textContent, 'Copied');
  newTimer(); assert.equal(h.D('copy-csv').textContent, 'Copy CSV');
});

test('closing during header read prevents metadata work from starting', async () => {
  const h = setup(), header = deferred();
  const pending = h.ctx.openOne({ name: 'orchard.parquet', size: 32, slice: () => ({ arrayBuffer: () => header.promise }) });
  await h.close(h.run('activeTab')); const before = h.snapshot();
  header.resolve(new Uint8Array([80, 65, 82, 49]).buffer); await pending;
  assert.equal(h.metadataReads.length, 0); assert.equal(h.reads.length, 0); assert.equal(h.snapshot(), before);
});

test('failed background metadata remains inspectable on its own tab', async () => {
  const h = setup(); const a = h.ctx.openOne(fakeFile('orchard')); await tick(); const id = h.run('activeTab');
  h.seed('b', 'meadow'); await loaded(h, 'b', [{ name: 'clover' }]);
  h.metadataReads.at(-1).reject(new Error('truncated metadata')); await a;
  await h.switchTab(id); assert.equal(h.D('status').className, 'error');
  assert.match(h.D('status').textContent, /truncated/); assertExportsDisabled(h);
  assert.equal(h.ctx.N.metadata, null); assert.equal(h.ctx.N.schema, null); assert.equal(h.ctx.N.rows, 0);
  await h.switchTab('b'); assert.equal(h.ctx.csv(), '"name"\r\n"clover"');
});

test('ordinary null, empty, quoted, Unicode, numeric and date values retain display and CSV formatting', async () => {
  const h = setup(); h.seed('a', 'orchard');
  await loaded(h, 'a', [{ name: '梨,"fruit"\nline', empty: '', absent: null, count: 2n, when: new Date('2026-01-02T00:00:00Z') }]);
  assert.equal(h.ctx.csv(), '"name","empty","absent","count","when"\r\n"梨,""fruit""\nline","","","2","2026-01-02T00:00:00.000Z"');
  assert.match(h.D('data-body').innerHTML, /class="null-value"/);
  assert.match(h.D('data-body').innerHTML, /class="empty-value"/);
  assert.match(h.D('data-body').innerHTML, /&quot;fruit&quot;/);
});

test('a failed new copy clears previous success feedback despite the superseded timer', async () => {
  const h = setup(); h.seed('a', 'orchard'); await loaded(h, 'a', [{ name: 'pear' }]);
  await h.D('copy-csv').onclick(); const oldTimer = h.timers.at(-1);
  assert.equal(h.D('copy-csv').textContent, 'Copied');
  h.ctx.navigator.clipboard.writeText = async () => { throw new Error('clipboard unavailable'); };
  await h.D('copy-csv').onclick(); oldTimer();
  assert.equal(h.D('copy-csv').textContent, 'Copy CSV'); assert.equal(h.D('status').className, 'error');
});
