const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'parquet-viewer.html'), 'utf8');
const begin = html.indexOf('<script type="module">') + '<script type="module">'.length;
const end = html.indexOf('var D = e => document.getElementById(e)', begin);
assert.ok(begin > 0 && end > begin);
const fixStart = html.indexOf('function decompressLz4Raw(');
const fixEnd = html.indexOf('function emptySession(', fixStart);
assert.ok(fixStart > end && fixEnd > fixStart, 'LZ4_RAW compatibility override must be shipped in the app');

const context = vm.createContext({
  TextDecoder, TextEncoder, WebAssembly,
  atob: input => Buffer.from(input, 'base64').toString('binary')
});
vm.runInContext(html.slice(begin, end) + '\n' + html.slice(fixStart, fixEnd) + '\nglobalThis.decoder = { Oe, Jt, hn };', context);
const { Oe, Jt, hn } = context.decoder;
const asAsyncFile = bytes => {
  // The decoder's strict instanceof ArrayBuffer check requires a buffer
  // created in the same JS realm as the decoder (as in a real browser).
  context.inputBytes = bytes;
  return vm.runInContext(`(() => {
    const source = inputBytes;
    return {
      byteLength: source.length,
      async slice(start, end) { return Uint8Array.from(source.subarray(start, end)).buffer; }
    };
  })()`, context);
};

const codecs = ['none', 'snappy', 'gzip', 'brotli', 'zstd', 'lz4'];
for (const codec of codecs) {
  test('actual Parquet ' + codec.toUpperCase() + ' across 8 row groups, nullable and Unicode data', { timeout: 30000 }, async () => {
    const bytes = fs.readFileSync(path.join(__dirname, 'generated-fixtures', codec + '.parquet'));
    const file = asAsyncFile(bytes);
    const metadata = await Oe(file);
    assert.equal(Number(metadata.num_rows), 123);
    assert.equal(metadata.row_groups.length, 8);
    assert.ok(metadata.row_groups.some(group => group.columns.some(col => col.meta_data?.codec === codec.toUpperCase() || codec === 'none' && col.meta_data?.codec === 'UNCOMPRESSED' || codec === 'lz4' && col.meta_data?.codec === 'LZ4_RAW')));

    for (const [start, end] of [[0, 1], [16, 18], [33, 77], [120, 123]]) {
      const rows = await Jt({ file, compressors: hn, rowStart: start, rowEnd: end, utf8: false });
      assert.equal(rows.length, end - start, codec + ': row count in [' + start + ',' + end + ')');
      for (let i = 0; i < rows.length; i++) {
        const index = start + i, row = rows[i];
        assert.equal(Number(row.id), index - 61, codec + ': id ' + index);
        assert.equal(row.name, index % 5 ? 'item-' + String(index).padStart(3, '0') : '東京-' + String(index).padStart(3, '0'), codec + ': Unicode ' + index);
        assert.equal(Number(row.amount), index / 4 - 10.5, codec + ': float ' + index);
        assert.equal(row.active, index % 2 === 0, codec + ': bool ' + index);
        assert.equal(row.notes == null ? null : row.notes, index % 7 === 0 ? null : 'quote,"line\n' + index + '"', codec + ': nullable multiline string ' + index);
        assert.deepEqual(Array.from(row.payload), [index % 256, 0, 255], codec + ': bytes ' + index);
        assert.equal(row.nullable == null ? null : row.nullable, index % 11 === 0 ? null : index * 2, codec + ': nullable integer ' + index);
      }
    }
  });
}

test('truncated, impossible footer-length and fuzzed input reject without hanging', { timeout: 15000 }, async () => {
  const sample = fs.readFileSync(path.join(root, 'assets', 'sample_snappy.parquet'));
  for (const n of [0, 1, 2, 4, 7, 8, 9, 12, 64, 512]) {
    await assert.rejects(() => Oe(asAsyncFile(sample.subarray(0, n))), undefined, 'truncated first ' + n + ' bytes');
  }
  const tooLargeMetadata = Buffer.from(sample);
  tooLargeMetadata.writeUInt32LE(0xffffffff, tooLargeMetadata.length - 8);
  await assert.rejects(() => Oe(asAsyncFile(tooLargeMetadata)), /metadata length|invalid/);
  let value = 0x12345678;
  for (let i = 0; i < 80; i++) {
    const size = 8 + i * 11;
    const bytes = Buffer.alloc(size);
    for (let j = 0; j < size; j++) {
      value ^= value << 13; value ^= value >>> 17; value ^= value << 5;
      bytes[j] = value & 255;
    }
    await assert.rejects(() => Oe(asAsyncFile(bytes)), undefined, 'random bytes ' + i);
  }
});

test('LZ4_RAW long-match extensions, overlapping copies and invalid bounds', () => {
  const longMatch = Uint8Array.from([0x1f, 0x61, 0x01, 0x00, 76, 0x50, 49, 50, 51, 52, 53]);
  const output = hn.LZ4_RAW(longMatch, 101);
  assert.equal(output.length, 101);
  assert.equal(Buffer.from(output).toString('ascii'), 'a'.repeat(96) + '12345');
  assert.throws(() => hn.LZ4_RAW(longMatch, 100), /Invalid LZ4 match length/);
  assert.throws(() => hn.LZ4_RAW(Uint8Array.from([0xf0]), 1), /Truncated LZ4 literal length/);
  assert.throws(() => hn.LZ4_RAW(Uint8Array.from([0x10, 0x61, 0, 0]), 5), /Invalid LZ4 match offset/);
  assert.throws(() => hn.LZ4_RAW(Uint8Array.from([0x10, 0x61, 2, 0]), 5), /Invalid LZ4 match offset/);
  assert.throws(() => hn.LZ4_RAW(Uint8Array.from([0x20, 0x61]), 2), /Invalid LZ4 literal length/);
  assert.throws(() => hn.LZ4_RAW(Uint8Array.from([0x10, 0x61]), 2), /Invalid LZ4 decompressed length/);
  assert.throws(() => hn.LZ4_RAW(Uint8Array.from([]), -1), /Invalid LZ4 output length/);
});
