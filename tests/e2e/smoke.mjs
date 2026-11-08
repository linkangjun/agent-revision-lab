// Run against a disposable local demo: npm run demo, then node tests/e2e/smoke.mjs.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright';

const url = new URL(process.env.ARL_E2E_URL ?? 'http://127.0.0.1:4317');
if (url.protocol !== 'http:' || !['localhost', '127.0.0.1'].includes(url.hostname)) {
  throw new Error('The smoke test creates test runs and only targets a disposable local demo.');
}
const browser = await chromium.launch({ channel: 'msedge', headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 980 }, acceptDownloads: true });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.setDefaultTimeout(25_000);
  const status = text => page.locator('.run-facts').getByText(text, { exact: true }).waitFor();
  const create = async scenario => {
    await page.getByRole('button', { name: 'New run' }).click();
    await page.getByLabel('Scenario').selectOption(scenario);
    await page.getByRole('button', { name: 'Start run' }).click();
    await status('Needs approval');
    await page.getByText('Scripted model', { exact: true }).waitFor();
  };

  await page.goto(url.href);
  await create('lost-receipt');
  await page.getByRole('button', { name: 'Revise goal' }).click();
  await page.getByLabel('Revised goal').fill('Compare stable v1 and v2, exclude beta, and check pagination before publishing.');
  await page.getByRole('button', { name: 'Save revision' }).click();
  await page.locator('.run-facts').getByText('REV 2', { exact: true }).waitFor();
  await status('Needs approval');
  await page.getByText('Abandoned', { exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Approve write' }).count(), 1);
  if (process.env.ARL_E2E_SCREENSHOT) {
    await page.screenshot({ path: process.env.ARL_E2E_SCREENSHOT, animations: 'disabled' });
  }
  await page.getByRole('button', { name: 'Approve write' }).click();
  await status('Succeeded');
  const revised = await page.request.get(await page.getByRole('link', { name: 'Export trace' }).getAttribute('href').then(path => new URL(path, url).href));
  assert.ok(revised.ok());
  const trace = await revised.json();
  assert.equal(trace.run.revision, 2);
  assert.equal(trace.operations.filter(op => op.state === 'CONFIRMED').length, 1);
  assert.ok(trace.events.some(event => event.type === 'goal.revised'));

  await create('no-lookup');
  await page.getByRole('button', { name: 'Approve write' }).click();
  await status('Needs reconciliation');
  await page.getByRole('button', { name: 'Reconcile outcome' }).click();
  const reconcile = page.getByRole('form', { name: 'Reconcile the write' });
  await reconcile.getByLabel('Observed outcome').selectOption('applied');
  await page.getByRole('heading', { name: 'Published reports' }).waitFor();
  const evidence = 'The synthetic destination lists the published report.';
  await reconcile.getByLabel('Evidence note').fill(evidence);
  assert.ok(await reconcile.getByRole('button', { name: 'Record outcome' }).isDisabled());
  await reconcile.getByRole('checkbox', { name: 'I verified this outcome at the destination.' }).check();
  await reconcile.getByRole('button', { name: 'Record outcome' }).click();
  await status('Succeeded');
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('link', { name: 'Export trace' }).click(),
  ]);
  const exported = await readFile(await download.path(), 'utf8');
  assert.equal(JSON.parse(exported).format, 'agent-revision-lab/incident-v1');
  assert.ok(!exported.includes(evidence), 'operator evidence note should be absent from the redacted download');

  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'the page should not overflow horizontally on mobile');
  assert.deepEqual(errors, []);
  console.log('Workbench smoke passed: goal revision, approval, lost receipt lookup, manual reconciliation, trace download, and mobile width.');
} finally {
  await browser.close();
}
