import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { connect, insert } from './helpers.mjs';

test('two browsers edit, share cursors, recover an offline draft and restore history', async ({
  browser,
  page,
}) => {
  const browserErrors = [];
  page.on('pageerror', (e) => browserErrors.push(e.message));
  await page.goto('/');
  await page.getByRole('button', { name: 'Create a document' }).click();
  await expect(page.getByRole('textbox', { name: 'Document content' })).toBeEnabled();
  const title = page.getByRole('textbox', { name: 'Document title' });
  await title.fill('Product launch notes');
  await title.blur();
  const editor = page.getByRole('textbox', { name: 'Document content' });
  await editor.fill('A shared starting point.');
  await expect(page.getByText('All changes saved', { exact: true })).toBeVisible();
  const other = await browser.newContext();
  const second = await other.newPage();
  await second.goto(page.url());
  const secondEditor = second.getByRole('textbox', { name: 'Document content' });
  await expect(secondEditor).toHaveValue('A shared starting point.');
  await second.getByRole('textbox', { name: 'Your display name' }).fill('Morgan');
  await secondEditor.focus();
  await secondEditor.press('End');
  await expect(page.getByText('2 here', { exact: true })).toBeVisible();
  await expect(page.locator('.remote-cursor')).toHaveCount(1);
  await secondEditor.fill('A shared starting point. Let’s make it happen.');
  await expect(editor).toHaveValue('A shared starting point. Let’s make it happen.');
  await expect(second.getByText('All changes saved', { exact: true })).toBeVisible();
  await other.setOffline(true);
  await secondEditor.fill('A shared starting point. Let’s make it happen. Offline idea.');
  await expect(second.getByText('Offline · saved on this device', { exact: true })).toBeVisible();
  await editor.fill('A shared starting point. Let’s make it happen. Live idea.');
  await expect(page.getByText('All changes saved', { exact: true })).toBeVisible();
  await other.setOffline(false);
  await expect(second.getByText('All changes saved', { exact: true })).toBeVisible({
    timeout: 30_000,
  });
  await expect(editor).toHaveValue(await secondEditor.inputValue());
  expect(await editor.inputValue()).toContain('Offline idea.');
  expect(await editor.inputValue()).toContain('Live idea.');
  await page.getByRole('button', { name: 'Version history', exact: true }).click();
  await expect(page.getByText('Every saved edit has a place here.')).toBeVisible();
  await page.getByRole('button', { name: /Version 1/ }).click();
  await page.getByRole('button', { name: 'Restore this version' }).click();
  await expect(editor).toHaveValue('A shared starting point.');
  await expect(secondEditor).toHaveValue('A shared starting point.');
  await expect(page.getByText('All changes saved', { exact: true })).toBeVisible();
  await page.screenshot({
    path: `../artifacts/${process.env.SCREENSHOT_PREFIX ?? 'editor'}-desktop.png`,
    fullPage: true,
  });
  await page.reload();
  await expect(editor).toHaveValue('A shared starting point.');
  expect(browserErrors).toEqual([]);
  await other.close();
});
test('same-browser tabs use unique IDs and offline pending edits survive reload', async ({
  context,
  page,
}) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Create a document' }).click();
  const editor = page.getByRole('textbox', { name: 'Document content' });
  await expect(editor).toBeEnabled();
  await editor.fill('Base.');
  await expect(page.getByText('All changes saved', { exact: true })).toBeVisible();
  const tab = await context.newPage();
  await tab.goto(page.url());
  const other = tab.getByRole('textbox', { name: 'Document content' });
  await expect(other).toHaveValue('Base.');
  await context.setOffline(true);
  await expect(page.getByText('Offline · saved on this device', { exact: true })).toBeVisible();
  await editor.fill('Base. First draft.');
  await other.fill('Base. Second draft.');
  // Let IndexedDB transactions complete; block only WebSockets after coming online for a reload.
  await expect
    .poll(async () =>
      page.evaluate(
        () =>
          new Promise((resolve) => {
            const r = indexedDB.open('syncspace', 1);
            r.onsuccess = () => {
              const q = r.result.transaction('documents').objectStore('documents').getAll();
              q.onsuccess = () => resolve(q.result.reduce((n, s) => n + s.pending.length, 0));
            };
          }),
      ),
    )
    .toBeGreaterThanOrEqual(2);
  await context.setOffline(false);
  await expect(page.getByText('All changes saved', { exact: true })).toBeVisible({
    timeout: 30_000,
  });
  await expect(tab.getByText('All changes saved', { exact: true })).toBeVisible({
    timeout: 30_000,
  });
  await expect(editor).toHaveValue(await other.inputValue());
  expect(await editor.inputValue()).toContain('First draft.');
  expect(await editor.inputValue()).toContain('Second draft.');
  let blockSocket = true;
  await context.routeWebSocket('**/ws/**', (ws) => {
    if (blockSocket) ws.close();
    else ws.connectToServer();
  });
  await page.reload();
  await expect(editor).toBeEnabled();
  await editor.fill((await editor.inputValue()) + ' Recovered after reload.');
  await expect
    .poll(async () =>
      page.evaluate(
        () =>
          new Promise((resolve) => {
            const r = indexedDB.open('syncspace', 1);
            r.onsuccess = () => {
              const q = r.result.transaction('documents').objectStore('documents').getAll();
              q.onsuccess = () => resolve(q.result.some((s) => s.pending.length));
            };
          }),
      ),
    )
    .toBe(true);
  await page.reload();
  await expect(editor).toHaveValue(/Recovered after reload\./);
  blockSocket = false;
  await page.reload();
  await expect(page.getByText('All changes saved', { exact: true })).toBeVisible({
    timeout: 30_000,
  });
  await tab.close();
});
test('mobile layout stays within the viewport', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: /Good work starts/ })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.getByRole('button', { name: 'Create a document' }).click();
  await expect(page.getByRole('textbox', { name: 'Document content' })).toBeEnabled();
  await page.getByRole('textbox', { name: 'Document content' }).fill('A small screen. A big idea.');
  await expect(page.getByText('All changes saved', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.screenshot({
    path: `../artifacts/${process.env.SCREENSHOT_PREFIX ?? 'editor'}-mobile.png`,
    fullPage: true,
  });
});

test('out-of-order and duplicate events converge; a missed final event is repaired', async ({
  context,
  page,
}) => {
  let first;
  let reordered = false;
  await context.routeWebSocket('**/ws/**', (ws) => {
    const server = ws.connectToServer();
    server.onMessage((raw) => {
      const event = JSON.parse(raw.toString());
      if (event.type === 'edit' && event.revision === 1) {
        first = raw;
        return;
      }
      if (event.type === 'edit' && event.revision === 2 && first) {
        ws.send(raw);
        ws.send(first);
        ws.send(first);
        reordered = true;
        return;
      }
      if (event.type === 'edit' && event.revision === 3) return;
      ws.send(raw);
    });
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Create a document' }).click();
  const editor = page.getByRole('textbox', { name: 'Document content' });
  await expect(editor).toBeEnabled();
  const url = new URL(page.url());
  const doc = {
    id: url.pathname.split('/').at(-1),
    key: new URLSearchParams(url.hash.slice(1)).get('key'),
  };
  const writer = await connect(doc);
  try {
    const batch = (ops) => ({ type: 'edit', batchId: randomUUID(), name: 'Writer', ops });
    const one = batch(insert('ordered', '', 'AB'));
    writer.send(one);
    await writer.wait((m) => m.batchId === one.batchId);
    const two = batch([
      { kind: 'insert', id: '000000000003:ordered', after: '000000000002:ordered', value: 67 },
    ]);
    writer.send(two);
    await writer.wait((m) => m.batchId === two.batchId);
    await expect(editor).toHaveValue('ABC');
    expect(reordered).toBe(true);
    const three = batch([
      { kind: 'insert', id: '000000000004:ordered', after: '000000000003:ordered', value: 68 },
    ]);
    writer.send(three);
    await writer.wait((m) => m.batchId === three.batchId);
    await expect(editor).toHaveValue('ABCD', { timeout: 12_000 });
    await expect(page.locator('.statusbar')).toContainText('v3');
  } finally {
    await writer.close();
  }
});
