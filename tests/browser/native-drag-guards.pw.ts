import { test, expect, type Page, type Locator } from '@playwright/test';
const id = '00000000-0000-4000-8000-000000000001';
const capture = (page: Page) =>
  page.getByRole('textbox', { name: 'Capture Markdown' });
async function seed(page: Page) {
  await page.goto('/?fixture');
  await capture(page).waitFor();
  await page.evaluate(async (id) => {
    const t = (window as any).__test;
    await t.repo.captureItem({
      id,
      location: { scope: 'live', itemId: null },
      markdown: 'saved **note**',
      draft: { key: 'compose', revision: 0 },
    });
    await t.controller.start();
    (window as any).__fileReads = 0;
    const read = FileReader.prototype.readAsText;
    FileReader.prototype.readAsText = function (...args) {
      (window as any).__fileReads++;
      return read.apply(this, args);
    };
  }, id);
}
async function state(page: Page) {
  return page.evaluate(() => {
    const t = (window as any).__test;
    return {
      snapshot: structuredClone(t.repo.snapshot),
      buffers: structuredClone(t.controller.state.buffers),
      activeKey: t.controller.state.activeKey,
    };
  });
}
async function drop(target: Locator, kind: 'file' | 'uri' | 'text') {
  return target.evaluate((el, kind) => {
    const transfer = new DataTransfer();
    if (kind === 'file')
      transfer.items.add(
        new File(['unexpected imported file source'], 'synthetic.txt', {
          type: 'text/plain',
        }),
      );
    else
      transfer.setData(
        kind === 'uri' ? 'text/uri-list' : 'text/plain',
        kind === 'uri'
          ? 'https://example.invalid/synthetic-drop'
          : ' dropped **exact**',
      );
    const rect = el.getBoundingClientRect();
    const event = new DragEvent('drop', {
      dataTransfer: transfer,
      bubbles: true,
      cancelable: true,
      clientX: rect.right - 4,
      clientY: rect.top + Math.min(10, rect.height / 2),
    });
    el.dispatchEvent(event);
    return {
      prevented: event.defaultPrevented,
      fileReads: (window as any).__fileReads,
    };
  }, kind);
}
for (const destination of ['capture', 'inline', 'background'] as const)
  test(`Files drop at ${destination} is canceled before FileReader or workspace mutation`, async ({
    page,
  }) => {
    await seed(page);
    let target: Locator;
    if (destination === 'inline') {
      await page.locator(`[data-entry-id="${id}"]`).dblclick();
      target = page.getByRole('textbox', { name: 'Edit Markdown' });
      await target.fill('inline retained source');
    } else {
      await capture(page).fill('capture retained source');
      target =
        destination === 'capture'
          ? capture(page)
          : page.locator('.note-stream');
    }
    await page.evaluate(() => (window as any).__test.controller.flush());
    const before = await state(page),
      url = page.url();
    const result = await drop(target, 'file');
    expect(result.fileReads).toBe(0);
    expect(result.prevented).toBe(true);
    expect(await state(page)).toEqual(before);
    expect(page.url()).toBe(url);
  });
test('unhandled background URI drops cancel default navigation and preserve source/items', async ({
  page,
}) => {
  await seed(page);
  const before = await state(page),
    url = page.url();
  for (const surface of ['.note-stream', '.sidebar', '.app-header']) {
    expect((await drop(page.locator(surface), 'uri')).prevented).toBe(true);
    expect(await state(page)).toEqual(before);
    expect(page.url()).toBe(url);
  }
});
for (const context of ['capture', 'inline'] as const)
  test(`ordinary ${context} text drop preserves exact source and editor Undo/Redo without reorder/capture`, async ({
    page,
  }) => {
    await seed(page);
    if (context === 'inline')
      await page.locator(`[data-entry-id="${id}"]`).dblclick();
    const editor =
      context === 'capture'
        ? capture(page)
        : page.getByRole('textbox', { name: 'Edit Markdown' });
    const original = `${context} source`;
    await editor.fill(original);
    await page.evaluate(() => (window as any).__test.controller.flush());
    const before = await state(page);
    expect((await drop(editor, 'text')).prevented).toBe(true);
    await expect(editor).toHaveText(original + ' dropped **exact**');
    await expect(editor).toBeFocused();
    await editor.press('Meta+z');
    await expect(editor).toHaveText(original);
    await editor.press('Meta+Shift+z');
    await expect(editor).toHaveText(original + ' dropped **exact**');
    const after = await state(page);
    expect(
      after.snapshot.items.map((x: any) => ({
        id: x.id,
        parentId: x.parentId,
        position: x.position,
      })),
    ).toEqual(
      before.snapshot.items.map((x: any) => ({
        id: x.id,
        parentId: x.parentId,
        position: x.position,
      })),
    );
    expect(after.activeKey).toBe(before.activeKey);
    expect(await page.evaluate(() => (window as any).__fileReads)).toBe(0);
  });
test('grip cursor is grab on hover, grabbing on press, and grab on release without geometry changes', async ({
  page,
}) => {
  await seed(page);
  const handle = page.getByRole('button', {
    name: 'Reorder item',
    exact: true,
  });
  await handle.hover();
  await expect(handle).toHaveCSS('cursor', 'grab');
  const before = await handle.boundingBox();
  await page.mouse.down();
  try {
    await expect(handle).toHaveCSS('cursor', 'grabbing', { timeout: 1000 });
    expect(await handle.boundingBox()).toEqual(before);
  } finally {
    await page.mouse.up();
  }
  await expect(handle).toHaveCSS('cursor', 'grab');
  expect((await state(page)).snapshot.items.map((x: any) => x.id)).toEqual([
    id,
  ]);
});
