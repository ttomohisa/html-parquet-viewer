const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

// Unlike the UI test doubles, exercise the actual bundled Parquet decoder against
// the checked-in sample. The same standalone script powers local file:// use.
const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'parquet-viewer.html'), 'utf8');
const begin = html.indexOf('<script type="module">') + '<script type="module">'.length;
const end = html.indexOf('var D = e => document.getElementById(e)', begin);
assert(begin > 0 && end > begin, 'embedded decoder boundaries');
const decoder = html.slice(begin, end);
const sampleBytes = fs.readFileSync(path.join(root, 'assets/sample_snappy.parquet'));

test('bundled standalone decoder opens and pages the real Snappy Parquet sample', { timeout: 15000 }, async () => {
  const context = vm.createContext({
    rawBytes: sampleBytes,
    TextDecoder,
    TextEncoder,
    WebAssembly,
    atob: base64 => Buffer.from(base64, 'base64').toString('binary')
  });
  vm.runInContext(decoder + `
    globalThis.parquetAPI = { Oe, Jt, hn };
    globalThis.parquetFile = {
      byteLength: rawBytes.length,
      async slice(start, end) { return Uint8Array.from(rawBytes.subarray(start, end)).buffer; }
    };
  `, context, { timeout: 10000 });
  const { Oe, Jt, hn } = context.parquetAPI;
  const file = context.parquetFile;
  const metadata = await Oe(file);
  assert.ok(Number(metadata.num_rows) >= 2, 'sample should have at least two rows');
  assert.ok(metadata.row_groups?.length > 0, 'row groups must be decoded');
  assert.ok(metadata.schema?.length > 1, 'schema fields must be decoded');
  const first = await Jt({ file, compressors: hn, metadata, rowStart: 0, rowEnd: 1 });
  const next = await Jt({ file, compressors: hn, metadata, rowStart: 1, rowEnd: 2 });
  assert.equal(first.length, 1);
  assert.equal(next.length, 1);
  assert.ok(Object.keys(first[0]).length > 0, 'sample row has columns');
  assert.deepEqual(Object.keys(first[0]), Object.keys(next[0]), 'schema is stable across page reads');
});
