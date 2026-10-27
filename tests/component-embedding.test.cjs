const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { embed, synchronize } = require('../scripts/embed-ui-conventions.cjs');
const repo = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(repo, 'parquet-viewer.html'), 'utf8');
const sources = Object.fromEntries([['JS', 'js'], ['CSS', 'css']].map(([kind, extension]) => [kind, fs.readFileSync(path.join(repo, 'components/ui-conventions.' + extension), 'utf8')]));

test('component embedding is idempotent, fixes stale blocks and rejects missing markers or parser drift', () => {
  assert.equal(embed(embed(html, sources), sources), embed(html, sources));
  const stale = html.replace('/* BEGIN BROWSER KITTY UI CSS */', '/* BEGIN BROWSER KITTY UI CSS */\n.stale {color:red}');
  assert.equal(embed(stale, sources), embed(html, sources));
  assert.throws(() => embed(html.replace('/* END BROWSER KITTY UI JS */', ''), sources), /marker pair/);
  assert.throws(() => embed(html.replace('/* BEGIN BROWSER KITTY UI CSS */', '/* BEGIN BROWSER KITTY UI CSS */\n/* BEGIN BROWSER KITTY UI CSS */'), sources), /marker pair/);
  assert.throws(() => embed(html.replace('var vt = [', 'var vt = [0,'), sources), /parser\/codecs changed/);
});

test('release check rejects stale embeds and modified vendored bytes before updating the HTML', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'parquet-ui-test-'));
  assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'components'));
  for (const file of ['ui-conventions.js', 'ui-conventions.css', 'ui-conventions.lock.json']) fs.copyFileSync(path.join(repo, 'components', file), path.join(root, 'components', file));
  const target = path.join(root, 'parquet-viewer.html');
  fs.writeFileSync(target, html.replace('/* BEGIN BROWSER KITTY UI CSS */', '/* BEGIN BROWSER KITTY UI CSS */\n.stale {color:red}'));
  assert.throws(() => synchronize({ root, check: true }), /embeds are stale/);
  synchronize({ root });
  assert.equal(synchronize({ root, check: true }).version, '1.0.0');
  const fixed = fs.readFileSync(target, 'utf8');
  fs.appendFileSync(path.join(root, 'components/ui-conventions.js'), '\n// accidental edit');
  assert.throws(() => synchronize({ root }), /hash mismatch/);
  assert.equal(fs.readFileSync(target, 'utf8'), fixed);
});
