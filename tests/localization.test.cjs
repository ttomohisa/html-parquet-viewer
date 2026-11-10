const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'parquet-viewer.html'), 'utf8');
const begin = html.indexOf('        const JA = {');
const end = html.indexOf('        function emptySession(', begin);
assert(begin > 0 && end > begin, 'localization code must be embedded in the standalone HTML');
const localeCode = html.slice(begin, end);

function localeHarness(browserLanguage = 'ja-JP', savedLanguage = null) {
  const attrs = { 'data-i18n': 'Download CSV' };
  const text = { textContent: '', getAttribute: key => attrs[key], setAttribute: (key, value) => { attrs[key] = value; } };
  const language = { textContent: '', setAttribute: (key, value) => { language[key] = value; } };
  const docLang = {};
  const saved = [];
  const document = {
    title: '',
    documentElement: { setAttribute(key, value) { docLang[key] = value; } },
    querySelectorAll(selector) { return selector === '[data-i18n]' ? [text] : []; }
  };
  const context = vm.createContext({
    navigator: { language: browserLanguage }, document, D: () => language, hn: {},
    localStorage: { getItem: () => savedLanguage, setItem: (key, value) => saved.push({ key, value }) }
  });
  vm.runInContext(localeCode, context);
  const run = source => vm.runInContext(source, context);
  return { run, text, document, language, docLang, saved };
}

test('Japanese browser preference renders translated UI without changing product identity', () => {
  const h = localeHarness();
  h.run('renderLocale()');
  assert.equal(h.text.textContent, 'CSVを保存');
  assert.equal(h.language.textContent, 'EN');
  assert.equal(h.language['aria-label'], '英語に切り替え');
  assert.equal(h.docLang.lang, 'ja');
  assert.match(h.document.title, /Parquet/);
  assert.equal(h.run('localizedStatus("Reading Parquet metadata…")'), 'Parquetファイルの情報を読み込んでいます…');
  assert.equal(h.run('localizedStatus("Ready — previewing 20 rows only.")'), '準備完了 — 20行をプレビューしています。');
  assert.equal(h.run('localizedStatus("Reading rows 1–20 of 35…")'), '全35行のうち1〜20行を読み込んでいます…');
  assert.match(h.run('localizedStatus("This is not a Parquet file: missing PAR1 header.")'), /PAR1/);
  assert.match(h.run('localizedStatus("Could not read this file: failed")'), /failed/);
});

test('saved English choice wins over Japanese browser, and switching updates rendered strings', () => {
  const h = localeHarness('ja-JP', 'en');
  h.run('renderLocale()');
  assert.equal(h.language.textContent, 'JA');
  assert.equal(h.language['aria-label'], 'Switch to Japanese');
  assert.equal(h.text.textContent, 'Download CSV');
  assert.equal(h.run('localizedStatus("Ready — previewing 20 rows only.")'), 'Ready — previewing 20 rows only.');
  h.run('lang = "ja"; renderLocale()');
  assert.equal(h.language.textContent, 'EN');
  assert.equal(h.text.textContent, 'CSVを保存');
  h.run('lang = "en"; renderLocale()');
  assert.equal(h.language.textContent, 'JA');
  assert.equal(h.text.textContent, 'Download CSV');
});

test('shipped document contains both language choices and localized controls', () => {
  const config = JSON.parse(fs.readFileSync(path.join(root, 'app.config.json'), 'utf8'));
  assert.deepEqual(config.languages, ['ja', 'en']);
  assert.match(html, /id="language" class="lang-toggle" type="button"/);
  assert.match(html, /class="lang-toggle"[^>]*>JA<\/button>/);
  assert.doesNotMatch(html, /<select id="language"/);
  assert.match(html, /data-i18n="Find values on this page"/);
  assert.match(html, /data-i18n-title="Download the current preview page as CSV"/);
  assert.match(html, /D\("language"\)\.onclick/);
});
