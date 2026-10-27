// Direct HTML remains authoritative. Only these two marked regions are generated.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');
const normalize = value => value.replace(/\r\n/g, '\n');
const parserHash = '51d853e242173311e2aa487ac01a25acaa04b98b2504c7c78c368b28eec55e5f';

function parser(html) {
  const marker = '<script type="module">';
  const start = html.indexOf(marker), end = html.indexOf('var D = e => document.getElementById(e)');
  if (start < 0 || end <= start) throw new Error('Parser boundaries are missing');
  const source = html.slice(start + marker.length, end);
  if (sha256(normalize(source)) !== parserHash) throw new Error('Embedded parser/codecs changed');
  return source;
}

function embed(html, sources) {
  const originalParser = parser(html);
  for (const [kind, source] of Object.entries(sources)) {
    const start = `/* BEGIN BROWSER KITTY UI ${kind} */`;
    const end = `/* END BROWSER KITTY UI ${kind} */`;
    const beginAt = html.indexOf(start), endAt = html.indexOf(end);
    if (beginAt < 0 || endAt < beginAt || html.indexOf(start, beginAt + 1) !== -1 || html.indexOf(end, endAt + 1) !== -1) throw new Error(`Expected exactly one ${kind} marker pair`);
    html = html.slice(0, beginAt) + start + '\n' + source + end + html.slice(endAt + end.length);
  }
  if (parser(html) !== originalParser) throw new Error('Embedding changed parser bytes');
  return html;
}

function synchronize({ root = path.resolve(__dirname, '..'), check = false } = {}) {
  const lock = JSON.parse(fs.readFileSync(path.join(root, 'components/ui-conventions.lock.json'), 'utf8'));
  if (lock.version !== '1.0.0' || lock.source !== 'htmlapps-template') throw new Error('Unexpected shared UI lock');
  const sources = {};
  for (const [kind, file] of [['JS', 'ui-conventions.js'], ['CSS', 'ui-conventions.css']]) {
    const bytes = fs.readFileSync(path.join(root, 'components', file));
    if (sha256(bytes) !== lock.files[file]) throw new Error(`Locked component hash mismatch: ${file}`);
    sources[kind] = bytes.toString('utf8');
  }
  const target = path.join(root, 'parquet-viewer.html');
  const current = fs.readFileSync(target, 'utf8'), updated = embed(current, sources);
  // Git's text checkout may use CRLF. The canonical component files are byte-locked;
  // inline script/style comparison ignores only that checkout line ending.
  if (check && normalize(current) !== normalize(updated)) throw new Error('Shared UI embeds are stale; run node scripts/embed-ui-conventions.cjs');
  if (!check && current !== updated) fs.writeFileSync(target, updated);
  return { version: lock.version, htmlSha256: sha256(fs.readFileSync(target)), parserSha256: parserHash };
}

module.exports = { embed, synchronize };
if (require.main === module) {
  try { console.log(JSON.stringify(synchronize({ check: process.argv.includes('--check') }))); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
