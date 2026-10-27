const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const { spawnSync } = require('node:child_process');

const html = fs.readFileSync(process.env.PARQUET_HTML || path.join(__dirname, '..', 'parquet-viewer.html'), 'utf8').replace(/\r\n/g, '\n');
const start = html.indexOf('var D = e => document.getElementById(e)');
const end = html.indexOf('</script>', start);
const sha256 = text => crypto.createHash('sha256').update(text).digest('hex');

test('embedded parser/codecs and notices retain their exact standalone byte contract', () => {
  // Baseline: 493e8b15b1e96aa53249e654b4d56128fdf5c63a. UI and app may change;
  // decoder bytes and bundled license notices may not. Only CRLF is normalized.
  const parserStart = html.indexOf('<script type="module">') + '<script type="module">'.length;
  assert(parserStart > 0 && start > parserStart && end > start);
  assert.equal(sha256(html.slice(parserStart, start)), '51d853e242173311e2aa487ac01a25acaa04b98b2504c7c78c368b28eec55e5f');
  assert.equal(sha256(html.slice(end)), '6365adc3517bc60a1e6bd471fedba80af09b51a1c8520d91b120a59971c8876d');
});

test('intentional bilingual additions preserve standalone CSP and runtime network isolation', () => {
  assert.match(html, /content="default-src 'none'; connect-src 'none'; script-src 'unsafe-inline' 'wasm-unsafe-eval'; style-src 'unsafe-inline'; img-src data:; object-src 'none'; base-uri 'none'; form-action 'none'; worker-src 'none';"/);
  assert.doesNotMatch(html, /<script[^>]+src=["']https?:\/\//i);
  assert.doesNotMatch(html, /<(?:link|script)[^>]+(?:href|src)=["'](?:components|https?:)/i);
  for (const id of ['choose-file','find-query','find-count','data-head','data-body','export-name','session-retention','language-ja','language-en','help-toggle']) assert.match(html, new RegExp('id="' + id + '"'));
});

test('every shipped inline script parses without executing the embedded parser', () => {
  const scripts = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)];
  assert.equal(scripts.length, 1);
  for (const [, source] of scripts) assert.doesNotThrow(() => new vm.Script(source));
});


test('every shipped inline module passes native module syntax checks', () => {
  const modules = [...html.matchAll(/<script\b[^>]*type=["']module["'][^>]*>([\s\S]*?)<\/script>/gi)];
  assert.equal(modules.length, 1);
  for (const [, source] of modules) {
    const checked = spawnSync(process.execPath, ['--input-type=module', '--check'], {input:source, encoding:'utf8'});
    assert.equal(checked.status, 0, checked.stderr);
  }
});
