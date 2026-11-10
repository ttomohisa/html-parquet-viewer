// Browser-level checks against the shipped single HTML. No app mocks are used.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { test, before, after } = require('node:test');
const { chromium } = require('playwright-core');

const root = path.resolve(__dirname, '..');
const htmlFile = path.join(root, 'parquet-viewer.html');
const sampleFile = path.join(root, 'assets', 'sample_snappy.parquet');
const appHtml = fs.readFileSync(htmlFile);
const candidates = [
  process.env.BROWSER_EXECUTABLE,
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  '/usr/bin/chromium',
  '/usr/bin/google-chrome'
].filter(Boolean);
const executablePath = candidates.find(p => fs.existsSync(p));
assert.ok(executablePath, 'a browser binary is required for the browser E2E checks');

let browser, server, localUrl;
before(async () => {
  browser = await chromium.launch({ executablePath, headless: true, args: ['--no-sandbox'] });
  server = http.createServer((req, res) => {
    if (req.url === '/' || req.url === '/parquet-viewer.html') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(appHtml);
    } else {
      res.writeHead(404); res.end('Not found');
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  localUrl = 'http://127.0.0.1:' + server.address().port + '/';
});
after(async () => {
  await browser?.close();
  if (server) await new Promise(resolve => server.close(resolve));
});

async function openPage({ locale = 'en-US', width = 1280, url = null } = {}) {
  const context = await browser.newContext({
    locale, viewport: { width, height: 840 }, acceptDownloads: true
  });
  const page = await context.newPage();
  const errors = [], unexpectedRequests = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => {
    if (!request.url().startsWith(localUrl) && !request.url().startsWith('file:') && !request.url().startsWith('data:')) {
      unexpectedRequests.push(request.url());
    }
  });
  try {
    await page.goto(url || localUrl, { waitUntil: 'load' });
    await page.locator('#language').waitFor({ state: 'visible' });
  } catch (err) {
    await context.close();
    throw err;
  }
  return { context, page, errors, unexpectedRequests,
    async close() { await context.close(); } };
}
async function ready(page) {
  await page.waitForFunction(() => document.querySelector('#status')?.classList.contains('ok')
    && document.querySelector('#data-head th[data-column]'), { timeout: 60000 });
}
async function loadSample(page) {
  await page.locator('#file').setInputFiles(sampleFile);
  await ready(page);
  assert.ok(await page.locator('#data-head th[data-column]').count() > 0);
  assert.ok(await page.locator('#data-body tr').count() > 0);
}
async function downloadCsv(page) {
  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 20000 }),
    page.locator('#download-csv').click()
  ]);
  const downloadedFile = await download.path();
  assert.ok(downloadedFile);
  return { filename: download.suggestedFilename(), value: fs.readFileSync(downloadedFile, 'utf8') };
}
async function captureOnFailure(page, err, label) {
  try {
    const folder = path.join(root, 'test-results');
    fs.mkdirSync(folder, { recursive: true });
    await page.screenshot({ path: path.join(folder, label + '.png'), fullPage: true });
  } catch {}
  throw err;
}

test('Japanese/English selection persists and narrow viewports stay usable', { timeout: 90000 }, async () => {
  const h = await openPage({ locale: 'ja-JP', width: 320 });
  try {
    const page = h.page;
    assert.equal(await page.locator('html').getAttribute('lang'), 'ja');
    assert.equal(await page.locator('#language').innerText(), 'EN');
    for (const width of [320, 360, 390, 600, 1280]) {
      await page.setViewportSize({ width, height: 840 });
      const sizes = await page.evaluate(() => {
        const title = document.querySelector('.header-top .title').getBoundingClientRect();
        const button = document.querySelector('#language').getBoundingClientRect();
        return {
          body: document.documentElement.scrollWidth, viewport: document.documentElement.clientWidth,
          titleEnd: title.right, buttonStart: button.left,
          buttonWidth: button.width, buttonHeight: button.height
        };
      });
      assert.ok(sizes.body <= sizes.viewport + 1, 'horizontal overflow at ' + width + ': ' + JSON.stringify(sizes));
      assert.ok(sizes.titleEnd <= sizes.buttonStart + 1, 'language control overlaps title at ' + width);
      assert.ok(sizes.buttonWidth >= 40 && sizes.buttonHeight >= 40, 'toggle too small at ' + width);
    }
    await page.locator('#language').click();
    assert.equal(await page.locator('html').getAttribute('lang'), 'en');
    assert.equal(await page.locator('#language').innerText(), 'JA');
    await page.reload();
    assert.equal(await page.locator('#language').innerText(), 'JA', 'saved choice should override browser language');
    assert.equal(h.errors.length, 0, h.errors.join('; '));
    assert.deepEqual(h.unexpectedRequests, [], 'no external requests');
  } catch (err) { await captureOnFailure(h.page, err, 'mobile-language'); }
  finally { await h.close(); }
});

test('real Parquet file: upload, schema, pagination, sorting, find, CSV and locale', { timeout: 150000 }, async () => {
  const h = await openPage();
  try {
    const page = h.page;
    await loadSample(page);
    assert.equal(await page.locator('#tabs [data-tab]').count(), 1);
    const first = await downloadCsv(page);
    assert.match(first.filename, /sample_snappy-page-1\.csv$/);
    assert.ok(first.value.startsWith('\uFEFF"'), 'UTF-8 BOM plus quoted header');
    assert.ok(first.value.split('\r\n').length > 1);

    const head = page.locator('#data-head th[data-column]').first();
    await head.locator('button').click();
    assert.equal(await page.locator('#data-head th[data-column]').first().getAttribute('aria-sort'), 'ascending');
    const sorted = await downloadCsv(page);
    assert.match(sorted.value, /\r\n/);
    await page.locator('#data-head th[data-column]').first().locator('button').click();
    assert.equal(await page.locator('#data-head th[data-column]').first().getAttribute('aria-sort'), 'descending');

    const candidate = await page.locator('#data-body tr td:not(.rownum)').allTextContents();
    const value = candidate.map(x => x.trim()).find(x => x.length >= 3 && x.toLowerCase() !== 'null');
    assert.ok(value, 'sample must contain searchable content');
    await page.locator('#find-query').fill(value.slice(0, 3));
    assert.notEqual(await page.locator('#find-count').innerText(), '');
    assert.ok(await page.locator('#data-body tr.find-match').count() > 0);
    const beforeToggle = await downloadCsv(page);
    await page.locator('#language').click();
    assert.equal(await page.locator('#language').innerText(), 'EN');
    assert.match(await page.locator('#find-count').innerText(), /一致行/);
    assert.equal((await downloadCsv(page)).value, beforeToggle.value, 'language must not change CSV values/order');
    await page.locator('#language').click();

    const rowCount = Number((await page.locator('#summary').innerText()).match(/Rows\s*([0-9,]+)/)?.[1]?.replaceAll(',', '') || 0);
    assert.ok(rowCount > 1);
    await page.locator('#page-size').selectOption('50');
    await ready(page);
    if (rowCount > 50) {
      await page.locator('#next').click();
      await ready(page);
      assert.match(await page.locator('#page-label').innerText(), /Page 2/);
      const second = await downloadCsv(page);
      assert.match(second.filename, /-page-2\.csv$/);
      await page.locator('#row-jump').fill('1');
      await page.locator('#row-jump').press('Tab');
      await ready(page);
      assert.match(await page.locator('#page-label').innerText(), /Page 1/);
    }
    assert.equal(h.errors.length, 0, h.errors.join('; '));
    assert.deepEqual(h.unexpectedRequests, [], 'no external requests');
  } catch (err) { await captureOnFailure(h.page, err, 'real-parquet'); }
  finally { await h.close(); }
});

test('invalid inputs, tab recovery, file:// startup, blocked network', { timeout: 100000 }, async () => {
  const h = await openPage();
  try {
    const page = h.page;
    await page.locator('#file').setInputFiles({ name: 'not-parquet.parquet', mimeType: 'application/octet-stream', buffer: Buffer.from('not a parquet file') });
    await page.waitForFunction(() => document.querySelector('#status')?.classList.contains('error'));
    assert.match(await page.locator('#status').innerText(), /PAR1/);
    assert.equal(await page.locator('#copy-csv').isDisabled(), true);

    await page.locator('#file').setInputFiles({ name: 'header-only.parquet', mimeType: 'application/octet-stream', buffer: Buffer.from('PAR1') });
    await page.waitForFunction(() => document.querySelector('#status')?.classList.contains('error') && /truncated|footer/i.test(document.querySelector('#status')?.textContent));
    assert.equal(await page.locator('#tabs [data-tab]').count(), 2);
    await page.locator('#language').click();
    assert.match(await page.locator('#status').innerText(), /ファイルが途中で切れている/);
    await page.locator('#tabs [data-close]').last().click();
    assert.equal(await page.locator('#tabs [data-tab]').count(), 1);
    await loadSample(page);
    assert.equal(await page.locator('#tabs [data-tab]').count(), 2);
    assert.equal(await page.evaluate(async () => {
      try { await fetch('https://example.com/no-external-connections'); return 'unexpected success'; }
      catch { return 'blocked'; }
    }), 'blocked');
    assert.equal(h.errors.length, 0, h.errors.join('; '));
    assert.deepEqual(h.unexpectedRequests, [], 'no external requests');
  } catch (err) { await captureOnFailure(h.page, err, 'errors-tabs'); }
  finally { await h.close(); }

  const offline = await openPage({ url: pathToFileURL(htmlFile).href, locale: 'ja-JP' });
  try {
    assert.equal(await offline.page.locator('html').getAttribute('lang'), 'ja');
    await loadSample(offline.page);
    assert.equal(offline.errors.length, 0, offline.errors.join('; '));
    assert.deepEqual(offline.unexpectedRequests, [], 'file:// must not need network');
  } catch (err) { await captureOnFailure(offline.page, err, 'offline-file'); }
  finally { await offline.close(); }
});
