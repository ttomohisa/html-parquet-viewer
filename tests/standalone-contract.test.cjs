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

test('embedded parser, codecs, CSP, markup and notices retain the pinned standalone contract', () => {
  // Baseline: d6f4df8337767a5f1463b6edc352d456026467db. Only the app suffix changes.
  // Normalize checkout line endings so this also runs on Windows.
  assert(start > 0 && end > start);
  assert.equal(sha256(html.slice(0, start)), '1b3acd2cd5ce33f472a9702820a652ac7b7d445c4b4691e700e8229fe269cf57');
  assert.equal(sha256(html.slice(end)), '6365adc3517bc60a1e6bd471fedba80af09b51a1c8520d91b120a59971c8876d');
  assert.match(html, /connect-src 'none'/);
  assert.doesNotMatch(html, /<script[^>]+src=["']https?:\/\//i);
});

test('every shipped inline script parses without executing the embedded parser', () => {
  const scripts = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)];
  assert.equal(scripts.length, 1);
  for (const [, source] of scripts) assert.doesNotThrow(() => new vm.Script(source));
});
