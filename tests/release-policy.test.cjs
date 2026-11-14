const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const root = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

test('the proposed release is versioned, documented and bound to merged main', () => {
  const config = JSON.parse(read('app.config.json'));
  assert.equal(Object.hasOwn(config, 'versionPolicy'), false, 'versioned apps must omit versionPolicy for registry compatibility');
  assert.match(config.version, /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/);
  const tag = 'v' + config.version;
  const notes = read('releases/' + tag + '.md');
  assert.match(notes, /HTML Parquet Viewer/);
  assert.match(notes, /offline|Offline/);

  const workflow = read('.github/workflows/release.yml');
  assert.match(workflow, /on:\s*\n  push:\s*\n    branches:\s*\n      - main/);
  assert.match(workflow, /github\.ref == 'refs\/heads\/main'/);
  assert.doesNotMatch(workflow, /^\s*pull_request:/m, 'PR branches must not publish a release');
  assert.match(workflow, /contents: write/);
  assert.match(workflow, /node --test tests\/\*\.test\.cjs/);
  assert.match(workflow, /git tag -a/);
  assert.match(workflow, /git push origin/);
  assert.match(workflow, /gh release view/);
  assert.match(workflow, /gh release create/);
  assert.match(workflow, /--verify-tag/);
  assert.match(workflow, /--notes-file/);
  assert.match(workflow, /parquet-viewer\.html SHA256SUMS\.txt/);
  assert.match(workflow, /sha256sum parquet-viewer\.html/);
  assert.match(workflow, /Refusing to move it/);
});
