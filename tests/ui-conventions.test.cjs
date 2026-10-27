const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test: nodeTest } = require('node:test');
const test = (name, fn) => nodeTest(name, { timeout: 2000 }, fn);

// Exercise shipped application functions with a DOM/download adapter.
// Most reads use parser-boundary doubles; the Snappy sample test runs the actual
// embedded parser/codecs. These checks do not use a browser.
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
function setup(options = {}) {
  const sourceHtml = options.sourceHtml || html, sourceStart = sourceHtml.indexOf("var D = e => document.getElementById(e)"), appSource = sourceHtml.slice(sourceStart, sourceHtml.indexOf("</script>", sourceStart));
  const elements = new Map(), reads = [], metadataReads = [], downloads = [], blobs = [], copied = [], timers = [];
  function element(id = '') {
    return { id, innerHTML: '', textContent: '', hidden: false, disabled: false, value: '', dataset: {}, style: {},
      classList: { add() {}, remove() {} }, addEventListener() {}, setAttribute(name, value) { this[name] = String(value); }, getAttribute(name) { return this[name] ?? null; }, removeAttribute(name) { delete this[name]; }, remove() {}, focus() {}, querySelector() { return null; },
      click() { downloads.push(this.download); },
      querySelectorAll(selector) {
        this.headers = selector === 'th[data-column]' ? [...this.innerHTML.matchAll(/data-column="([^"]*)"/g)].map(m => ({ dataset: { column: m[1] } })) : [];
        return this.headers;
      }
    };
  }
  const D = id => { if (!elements.has(id)) elements.set(id, element(id)); return elements.get(id); };
  const staticNodes = [];
  for (const match of sourceHtml.slice(0, sourceHtml.indexOf('<script')).matchAll(/<([a-z][\w-]*)\b([^>]*)>/gi)) {
    const attrs = [...match[2].matchAll(/([\w-]+)(?:="([^"]*)")?/g)];
    const id = attrs.find(attr => attr[1] === "id")?.[2];
    const node = id ? D(id) : element(); for (const attr of attrs) node.setAttribute(attr[1], attr[2] || ""); if (attrs.some(attr => attr[1] === "hidden")) node.hidden = true;
    if (Object.keys(node).some(key => key.startsWith("data-i18n"))) staticNodes.push(node);
  }
  const ctx = vm.createContext({
    atob, TextDecoder, TextEncoder, ArrayBuffer, URLSearchParams, location: { href: options.url || 'file:///parquet-viewer.html' }, history: { state: null, replaceState(state, title, url) { this.url = url; } }, localStorage: options.storage || { getItem() { return null; }, setItem() {} }, console: { error() {} }, document: { documentElement: element("html"), getElementById: D, querySelectorAll: selector => staticNodes.filter(node => node.getAttribute(selector.slice(1,-1)) !== null), createElement: () => element(), body: { append() {} } },
    navigator: { languages: options.languages || ['en-US'], clipboard: { writeText: async text => { copied.push(text); } } }, window: { isSecureContext: true },
    Uint8Array, Date, Blob, setTimeout: callback => { timers.push(callback); return timers.length; },
    URL: class extends URL { static createObjectURL(blob) { blobs.push(blob); return 'blob:synthetic'; } static revokeObjectURL() {} }, hn: {},
    Jt: options => { const d = deferred(); reads.push({ options, ...d }); return d.promise; },
    Oe: file => { const d = deferred(); metadataReads.push({ file, ...d }); return d.promise; },
    J: () => ({ children: [{ element: { name: 'name', type: 'BYTE_ARRAY', converted_type: 'UTF8' }, children: [] }] })
  });
  if (options.realParser) vm.runInContext(sourceHtml.slice(sourceHtml.indexOf('<script type="module">') + '<script type="module">'.length, sourceStart), ctx);
  vm.runInContext(appSource, ctx, { filename: 'shipped-parquet-app.js' });
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
  return { ctx, run, D, staticNodes, reads, metadataReads, downloads, blobs, copied, timers, seed, close, switchTab, snapshot };
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


// Fails if the editable name is ignored or Find changes the exported page.
test('editable CSV name is sanitized and current-page scope ignores Find', async () => {
  const h = setup(); h.seed('a', 'orchard');
  await loaded(h, 'a', [{ name: 'pear', n: 9223372036854775807n, blank: null, date: new Date('2026-01-01Z'), bytes: new Uint8Array([1, 2]) }]);
  h.D('export-name').value = '../harvest?:.csv'; h.D('export-name').oninput?.({ target: h.D('export-name') });
  h.D('find-query').oninput({target: {value: 'unmatched'}});
  h.ctx.downloadCsv();
  assert.equal(h.downloads.at(-1), '.._harvest__.csv');
  assert.equal(await h.blobs.at(-1).text(), '"name","n","blank","date","bytes"\r\n"pear","9223372036854775807","","2026-01-01T00:00:00.000Z","Uint8Array(2) 0102"');
  assert.match(h.D('export-scope').textContent, /current page.*1.*Find/i);
  assert.match(h.D('status').textContent, /Download started.*harvest/);
});
// Fails if URL resolution or translation mutates the preview/session or cannot handle rejected storage.
test('URL Japanese and explicit language selection preserve page identity with rejected storage', async () => {
  const h = setup({ url: 'https://example.test/?lang=ja', storage: {getItem() {throw Error('blocked');}, setItem() {throw Error('blocked');}} });
  assert.match(h.D('session-retention').textContent, /タブ/);
  h.seed('a', 'orchard'); await loaded(h, 'a', [{name:'pear'}]);
  h.D('find-query').oninput({target: {value:'pear'}});
  const before = h.ctx.N.completedPage, reads = h.reads.length;
  h.ctx.chooseAppLanguage('en');
  assert.equal(h.ctx.N.completedPage, before); assert.equal(h.reads.length, reads);
  assert.equal(h.ctx.N.findQuery, 'pear'); assert.equal(h.D('page-label').textContent, 'Page 1 of 2');
  assert.match(h.D('language-status').textContent, /screen only/);
  assert.match(h.ctx.history.url, /lang=en/);
  h.ctx.chooseAppLanguage('ja');
  assert.equal(h.ctx.N.completedPage, before); assert.equal(h.ctx.csv(), '"name"\r\n"pear"');
  assert.match(h.D('find-count').textContent, /一致/);
});
test('language switch during a pending read updates progress and eventual errors without replacing work', async () => {
  const h=setup(); h.seed('a','orchard'); const pending=h.ctx.activate('a');
  h.ctx.chooseAppLanguage('ja'); assert.match(h.D('status').textContent,/読み込み/);
  assert.equal(h.D('download-csv').disabled,true); assert.equal(h.D('copy-csv').disabled,true);
  h.reads.at(-1).reject(new Error('invalid footer')); await pending;
  assert.match(h.D('status').textContent,/フッター/); assert.equal(h.D('status').className,'error');
  h.ctx.chooseAppLanguage('en'); assert.match(h.D('status').textContent,/footer/);
  assert.equal(h.ctx.N.file.name,'orchard.parquet');
});
test('duplicate copy is blocked and translation keeps the request owned by its tab', async () => {
  const h=setup(); h.seed('a','orchard'); await loaded(h,'a',[{name:'pear'}]);
  const d=deferred(); let count=0; h.ctx.navigator.clipboard.writeText=()=>{count++; return d.promise;};
  const first=h.D('copy-csv').onclick(); const second=h.D('copy-csv').onclick();
  assert.equal(count,1); assert.equal(h.D('copy-csv').disabled,true);
  h.ctx.chooseAppLanguage('ja'); assert.equal(h.D('copy-csv').disabled,true);
  d.resolve(); await Promise.all([first,second]);
  assert.match(h.D('copy-csv').textContent,/コピー済み/); assert.equal(h.D('copy-csv').disabled,false);
  h.ctx.chooseAppLanguage('en'); assert.equal(h.D('copy-csv').textContent,'Copied');
});


test('language controls translate metadata, help, labels and errors without promoting a preference at startup', () => {
  const writes=[]; const h=setup({url:'https://example.test/?lang=ja',languages:['en-US'],storage:{getItem(){return 'en';},setItem(...args){writes.push(args);}}});
  assert.equal(writes.length,0); assert.equal(h.ctx.document.documentElement.lang,'ja');
  assert.match(h.ctx.document.title,/ビューアー/); assert.match(h.D('document-description').content,/ブラウザー/);
  assert.match(h.D('find-query').placeholder,/検索/); assert.match(h.D('download-csv').textContent,/保存/);
  assert.match(h.D('help-toggle').textContent,/ヘルプ/); assert.equal(h.D('app-help').hidden,true);
  h.D('help-toggle').onclick(); assert.equal(h.D('app-help').hidden,false);
  assert.equal(h.D('help-toggle')['aria-expanded'],'true');
  for (const node of h.staticNodes) for (const [attribute,target] of [['data-i18n','textContent'],['data-i18n-title','title'],['data-i18n-aria','aria-label'],['data-i18n-placeholder','placeholder']]) {
    const key=node.getAttribute(attribute); if(key) { assert.notEqual(node[target],key); assert(node[target],key+' translated'); }
  }
  for (const [message,stage,want] of [['missing PAR1 header','header',/PAR1/],['truncated','header',/フッター/],['unsupported codec','header',/対応していない/],['allocation failed','preview',/行数を減らして/],['other failure','header',/読み込めません/]]) assert.match(h.ctx.friendlyError(new Error(message),stage),want);
  h.D('language-en').onclick(); assert.equal(h.ctx.document.documentElement.lang,'en');
  assert.equal(h.ctx.document.title,'HTML Parquet Viewer'); assert.equal(h.D('help-toggle').textContent,'Help');
  assert.equal(h.D('app-help').hidden,false); assert.deepEqual(writes,[['browser-kitty:ui-language:v1','en']]);
});

test('CSV name, order and bytes are captured before download delivery can change the active tab', async () => {
  const h=setup(); h.seed('a','orchard');h.seed('b','meadow'); await loaded(h,'a',[{name:'pear'},{name:'apple'}]);
  h.ctx.N.sortColumn='name'; h.ctx.N.sortDirection=1;
  h.D('export-name').value='harvest'; h.D('export-name').oninput({target:h.D('export-name')});
  await loaded(h,'b',[{name:'clover'}]); await h.ctx.activate('a');
  assert.equal(h.D('export-name').value,'harvest');
  let delivered;
  h.ctx.document.createElement=()=>({click(){delivered=this.download;h.ctx.activate('b');},remove(){}});
  h.ctx.downloadCsv();
  assert.equal(delivered,'harvest.csv');assert.equal(await h.blobs.at(-1).text(),'"name"\r\n"apple"\r\n"pear"');
  assert.equal(h.ctx.N.file.name,'meadow.parquet');assert.doesNotMatch(h.D('status').textContent,/Download started/);
});

nodeTest('bundled Snappy sample retains baseline CSV bytes across pages, sorting, Find and language', {timeout:15000}, async () => {
  const crypto=require('node:crypto'), h=setup({realParser:true}), bytes=fs.readFileSync(path.join(__dirname,'..','assets/sample_snappy.parquet')), blob=new Blob([bytes]);
  await h.ctx.openOne({name:'sample_snappy.parquet',size:bytes.length,slice:(a,b)=>blob.slice(a,b)});
  const hash=()=>crypto.createHash('sha256').update(h.ctx.csv()).digest('hex');
  assert.equal(h.ctx.N.rows,10000);assert.equal(h.ctx.N.lastRows.length,100);
  // Independently captured from the exact baseline 0e8c03c9dcb85f54f9db79d014c4693a4e55b69a.
  assert.equal(hash(),'1ee03e2f42800bff235c4cd627edc8dfc0bb8ad89eb07f4e988edc598c62f77c');
  await h.D('next').onclick();assert.equal(hash(),'9e262dece87fca2eb3e0fecee87215c5ec9915cf7a835c89ec46ed4ebf1f069f');
  h.ctx.N.sortColumn='id_int64';h.ctx.N.sortDirection=-1;h.ctx.renderSession();
  h.D('find-query').oninput({target:{value:'no matching rows in this sample'}});h.ctx.chooseAppLanguage('ja');
  assert.equal(hash(),'43ab2428d72c3f945d36cdff366aced2bdcce60794eb7049c9e1c6befa14cc2f');
  h.D('export-name').value='sample sorted';h.ctx.downloadCsv();
  assert.equal(h.downloads.at(-1),'sample sorted.csv');
  const output=new Uint8Array(await h.blobs.at(-1).arrayBuffer());assert.deepEqual([...output.slice(0,3)],[239,187,191]);
  assert.equal(await h.blobs.at(-1).text(),h.ctx.csv());
  const oldId=h.run('activeTab'), before=h.ctx.N.completedPage;
  for (const data of [new Uint8Array([0,0,0,0]),bytes.subarray(0,bytes.length-6)]) {
    const bad=new Blob([data]);await h.ctx.openOne({name:'invalid.parquet',size:data.length,slice:(a,b)=>bad.slice(a,b)});
    assert.equal(h.D('download-csv').disabled,true);assert.equal(h.D('copy-csv').disabled,true);assert.equal(h.D('status').role,'alert');
    assert.match(h.D('status').textContent,/PAR1|フッター/);
  }
  await h.ctx.activate(oldId);assert.equal(h.ctx.N.completedPage,before);
  assert.equal(hash(),'43ab2428d72c3f945d36cdff366aced2bdcce60794eb7049c9e1c6befa14cc2f');
});


test('the embedded ZSTD decoder remains callable after app initialization and language changes', () => {
  const h=setup({realParser:true});
  // Fixed frame independently encoded by Node zlib Zstandard, not by the embedded decoder.
  const frame=new Uint8Array([40,181,47,253,96,128,0,253,0,0,192,80,97,114,113,117,101,116,32,90,83,84,68,32,114,101,103,114,101,115,115,105,111,110,32,1,0,148,173,58,199]);
  assert.equal(Buffer.from(h.ctx.hn.ZSTD(frame)).toString('utf8'),'Parquet ZSTD regression '.repeat(16));
  h.ctx.chooseAppLanguage('ja');
  assert.equal(Buffer.from(h.ctx.hn.ZSTD(frame)).toString('utf8'),'Parquet ZSTD regression '.repeat(16));
});

test('returning to an older pending copy reconciles native busy state without stale feedback', async () => {
  for (const failA of [false,true]) for (const failB of [false,true]) for (const bFirst of [false,true]) {
    const h=setup();h.seed('a','orchard');h.seed('b','meadow');
    await loaded(h,'a',[{name:'pear'}]);await loaded(h,'b',[{name:'clover'}]);await h.ctx.activate('a');
    const page=h.ctx.N.completedPage, a=deferred(), b=deferred();let calls=0;
    h.ctx.navigator.clipboard.writeText=()=>++calls===1?a.promise:b.promise;
    const copyingA=h.D('copy-csv').onclick();
    await h.ctx.activate('b');const copyingB=h.D('copy-csv').onclick();await h.ctx.activate('a');
    const status=h.D('status').textContent, kind=h.D('status').className;
    assert.equal(h.D('copy-csv').disabled,true);assert.equal(h.D('copy-csv').textContent,'Copying CSV…');
    const settleB=async()=>{if(failB)b.reject(Error('clipboard B rejected'));else b.resolve();await copyingB;};
    if(bFirst) {await settleB();assert.equal(h.D('copy-csv').disabled,true);assert.equal(h.D('copy-csv').textContent,'Copying CSV…');}
    if(failA)a.reject(Error('clipboard A rejected'));else a.resolve();await copyingA;
    assert.equal(h.ctx.N.completedPage,page);assert.equal(h.D('copy-csv').disabled,false);
    assert.equal(h.D('copy-csv')['data-bk-state'],'ready');assert.equal(h.D('copy-csv').textContent,'Copy CSV');
    assert.equal(h.D('status').textContent,status);assert.equal(h.D('status').className,kind);
    // A is actionable again while B can still be pending; B's completion must
    // not remove the new A feedback or rewrite the current page's status.
    h.ctx.navigator.clipboard.writeText=async()=>{calls++;};await h.D('copy-csv').onclick();
    assert.equal(calls,3);assert.equal(h.D('copy-csv').textContent,'Copied');
    const current=h.snapshot();if(!bFirst)await settleB();assert.equal(h.snapshot(),current);
  }
});
