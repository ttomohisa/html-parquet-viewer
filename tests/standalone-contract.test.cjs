const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

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

test('existing markup and restrictive CSP stay intact around the intentional UI additions', () => {
  const parserStart = html.indexOf('<script type="module">') + '<script type="module">'.length;
  let markup = html.slice(0, parserStart);
  const additions = [
    /\t\t#summary\[hidden\],\n\t\t#pager\[hidden\] \{\n\t\t\tdisplay: none\n\t\t\}\n\n/g,
    /\t\t\/\* Page find styles \*\/[\s\S]*?\/\* \/Page find styles \*\/\n/g,
    /\n                <!-- Page find controls -->[\s\S]*?<!-- \/Page find controls -->/g
  ];
  for (const addition of additions) {
    assert.equal([...markup.matchAll(addition)].length, 1, 'only the exact hidden-display rule and explicit find UI regions are excluded');
    markup = markup.replace(addition, '');
  }
  // Icon normalization: only the logo and embedded favicon changed; runtime bytes stay pinned above.
  assert.equal(sha256(markup), 'cc54b9b408d4d609ff48cd2928ad9d9cddc40ca919bb2dd4f46146f30eb093d1');
  assert.match(html, /content="default-src 'none'; connect-src 'none'; script-src 'unsafe-inline' 'wasm-unsafe-eval'; style-src 'unsafe-inline'; img-src data:; object-src 'none'; base-uri 'none'; form-action 'none'; worker-src 'none';"/);
  assert.doesNotMatch(html, /<script[^>]+src=["']https?:\/\//i);
});

test('every shipped inline script parses without executing the embedded parser', () => {
  const scripts = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)];
  assert.equal(scripts.length, 1);
  for (const [, source] of scripts) assert.doesNotThrow(() => new vm.Script(source));
});
