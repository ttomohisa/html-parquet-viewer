const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const root = path.join(__dirname, '..');
const asset = fs.readFileSync(path.join(root, 'assets/favicon.svg'), 'utf8');
const html = fs.readFileSync(path.join(root, 'parquet-viewer.html'), 'utf8');
const inner = svg => svg.replace(/^[\s\S]*?<svg\b[^>]*>/, '').replace(/<\/svg>[\s\S]*$/, '').replace(/\s+/g, ' ').trim();
test('brand asset has the exact quarter-side rounded background', () => {
  const rect = asset.match(/<rect\b[^>]*>/)[0];
  for (const attr of ['rx', 'ry']) assert.match(rect, new RegExp(`${attr}="6"`));
  assert.match(rect, /width="24" height="24"/);
  assert.match(rect, /fill="#16624f"/i);
});
test('header and embedded favicon preserve the canonical icon artwork', () => {
  const header = html.match(/<svg\b[^>]*class="logo"[\s\S]*?<\/svg>/)[0];
  const favicon = decodeURIComponent(html.match(/href="data:image\/svg\+xml,([^"]+)"/)[1]);
  assert.equal(inner(header), inner(asset));
  assert.equal(inner(favicon), inner(asset));
});
