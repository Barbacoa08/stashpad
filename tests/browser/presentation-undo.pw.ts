import { test, expect, type Page } from '@playwright/test';

const capture = (page: Page) =>
  page.getByRole('textbox', { name: 'Capture Markdown' });
const stream = (page: Page) =>
  page.getByRole('region', { name: 'Note stream' });
const card = (page: Page, id: string) =>
  page.locator(`[data-entry-id="${id}"]`);
async function seed(page: Page) {
  await page.goto('/?fixture');
  await capture(page).waitFor();
  return page.evaluate(async () => {
    const t = (window as any).__test;
    const ids = [crypto.randomUUID(), crypto.randomUUID()];
    for (const [index, markdown] of [
      'first exact source',
      'second surviving source',
    ].entries())
      await t.repo.captureItem({
        id: ids[index],
        location: { scope: 'live', itemId: null },
        markdown,
        draft: { key: 'compose', revision: 0 },
      });
    await t.controller.start();
    return ids;
  });
}
async function deleted(page: Page) {
  const ids = await seed(page);
  await card(page, ids[0]).click();
  await page.keyboard.press('Meta+Backspace');
  await expect(card(page, ids[0])).toHaveCount(0);
  await expect(stream(page)).toBeFocused();
  return ids;
}
const marker = (page: Page) =>
  page.evaluate(() => (window as any).__test.repo.snapshot.undoDeleteIds);
async function workspaceZ(
  page: Page,
  overrides: Partial<
    Pick<
      KeyboardEventInit,
      'repeat' | 'isComposing' | 'altKey' | 'ctrlKey' | 'shiftKey'
    >
  > = {},
) {
  return stream(page).evaluate((el, overrides) => {
    const event = new KeyboardEvent('keydown', {
      key: 'z',
      metaKey: true,
      bubbles: true,
      cancelable: true,
      ...overrides,
    });
    el.dispatchEvent(event);
    return event.defaultPrevented;
  }, overrides);
}

test('concise local activity retains actual live status and error recovery', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1400, height: 800 });
  await seed(page);
  const status = page.getByRole('region', { name: 'Workspace status' });
  await expect(status.getByRole('heading')).toHaveText('Local activity');
  await expect(status).toContainText('Notes and drafts on this Mac.');
  await capture(page).fill('retained local draft');
  await page.evaluate(() => {
    (window as any).__test.repo.fail = 'checkpoint';
  });
  await page.getByRole('button', { name: 'Root', exact: true }).click();
  await expect(status.getByRole('alert')).toContainText('checkpoint failure');
  await expect(status.getByRole('status').first()).toHaveText(
    await page.evaluate(() => (window as any).__test.controller.state.status),
  );
  await expect(
    status.getByRole('button', { name: 'Retry action' }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Hide Details', exact: true }).click();
  await expect(
    status.getByRole('button', { name: 'Retry action' }),
  ).toBeVisible();
  await expect(capture(page)).toHaveText('retained local draft');
});

for (const scale of [100, 150])
  test(`footer shares Search and Root icon and label columns at ${scale}% with one scroll surface`, async ({
    page,
  }) => {
    await page.setViewportSize({
      width: scale === 150 ? 800 : 1440,
      height: 600,
    });
    await deleted(page);
    if (scale === 150)
      await page.addStyleTag({ content: ':root{font-size:24px!important}' });
    const columns = await page.locator('.sidebar').evaluate((el) => {
      const search = el.querySelector('.sidebar-search')!,
        home = el.querySelector('.root-link')!;
      const columns = [
        search,
        home,
        ...el.querySelectorAll('.backup-actions button'),
      ].map((item) => {
        const icon = item.querySelector('svg')!.getBoundingClientRect();
        if (item === search)
          return {
            icon: icon.x + icon.width / 2,
            label: item.querySelector('input')!.getBoundingClientRect().x,
          };
        const text = [...item.childNodes].find(
          (node) =>
            node.nodeType === Node.TEXT_NODE && node.textContent?.trim(),
        )!;
        const range = document.createRange();
        range.selectNodeContents(text);
        const offset = text.textContent!.search(/\S/);
        range.setStart(text, offset);
        return {
          icon: icon.x + icon.width / 2,
          label: range.getBoundingClientRect().x,
        };
      });
      return columns;
    });
    expect(
      Math.max(...columns.map((x) => x.icon)) -
        Math.min(...columns.map((x) => x.icon)),
    ).toBeLessThanOrEqual(0.1);
    expect(
      Math.max(...columns.map((x) => x.label)) -
        Math.min(...columns.map((x) => x.label)),
    ).toBeLessThanOrEqual(0.1);
    await page.evaluate(async () => {
      const t = (window as any).__test;
      for (let i = 0; i < 30; i++)
        await t.repo.createChildTree({
          id: crypto.randomUUID(),
          parent: { scope: 'live', itemId: null },
        });
      await t.controller.start();
    });
    const sidebar = page.locator('.sidebar');
    expect(
      await sidebar.evaluate(
        (el) =>
          [...el.querySelectorAll('*')].filter(
            (inner) =>
              ['auto', 'scroll'].includes(getComputedStyle(inner).overflowY) &&
              inner.scrollHeight > inner.clientHeight,
          ).length,
      ),
    ).toBe(0);
    for (const name of [
      'Trash',
      'Export backup',
      'Restore backup',
      'Undo delete',
    ]) {
      const action = page.getByRole('button', { name, exact: true });
      await action.focus();
      await expect(action).toBeFocused();
      const r = (await action.boundingBox())!;
      expect(r.y).toBeGreaterThanOrEqual(0);
      expect(r.y + r.height).toBeLessThanOrEqual(600);
      expect(
        await action.evaluate((el) => {
          const r = el.getBoundingClientRect();
          return el.contains(
            document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2),
          );
        }),
      ).toBe(true);
    }
  });

test('palette renders swatches and a reset glyph while retaining names, saved check, and staging', async ({
  page,
}) => {
  const ids = await seed(page);
  await card(page, ids[0]).click();
  await page.keyboard.press('l');
  const palette = page.getByRole('dialog', { name: 'Assign color' });
  const reset = palette.getByRole('button', { name: 'Reset', exact: true });
  await expect(reset).toBeFocused();
  await expect(reset).toHaveAttribute('aria-pressed', 'true');
  await expect(reset.locator('.color-saved')).toHaveText('✓');
  for (const name of [
    'Red',
    'Orange',
    'Yellow',
    'Green',
    'Teal',
    'Blue',
    'Purple',
    'Pink',
    'Gray',
    'Reset',
  ]) {
    const button = palette.getByRole('button', { name, exact: true });
    await expect(button).toBeVisible();
    expect(await button.innerText()).not.toContain(name);
  }
  await reset.press('ArrowUp');
  await expect(
    palette.getByRole('button', { name: 'Pink', exact: true }),
  ).toBeFocused();
  expect(await marker(page)).toEqual([]);
  await page.keyboard.press('Enter');
  await expect(palette).toHaveCount(0);
  await expect
    .poll(() =>
      page.evaluate(
        (id) =>
          (window as any).__test.repo.snapshot.items.find(
            (x: any) => x.id === id,
          ).color,
        ids[0],
      ),
    )
    .toBe('pink');
});

test('workspace Command-Z restores the exact persistent deletion once and selects it', async ({
  page,
}) => {
  const ids = await deleted(page);
  expect(await workspaceZ(page)).toBe(true);
  await expect(card(page, ids[0])).toHaveClass(/selected/);
  await expect(stream(page)).toBeFocused();
  expect(await marker(page)).toEqual([]);
  expect(await workspaceZ(page)).toBe(false);
  expect(
    await page.evaluate(
      () => (window as any).__test.repo.snapshot.items.length,
    ),
  ).toBe(2);
});

for (const guard of [
  { repeat: true },
  { isComposing: true },
  { altKey: true },
  { ctrlKey: true },
  { shiftKey: true },
])
  test(`workspace Undo ignores ${Object.keys(guard)[0]} without preventing default`, async ({
    page,
  }) => {
    const ids = await deleted(page);
    expect(await workspaceZ(page, guard)).toBe(false);
    expect(await marker(page)).toEqual([ids[0]]);
  });

test('document selection, palette, modal, busy state, and focused controls retain their Undo boundary', async ({
  page,
}) => {
  const ids = await deleted(page);
  await card(page, ids[1])
    .locator('.note-body')
    .evaluate((el) => {
      const range = document.createRange();
      range.selectNodeContents(el);
      const selection = window.getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);
    });
  expect(await workspaceZ(page)).toBe(false);
  await page.evaluate(() => window.getSelection()?.removeAllRanges());
  await page.keyboard.press('l');
  expect(await workspaceZ(page)).toBe(false);
  await page.keyboard.press('Escape');
  await page
    .getByRole('button', { name: 'Export backup', exact: true })
    .focus();
  await page.keyboard.press('Meta+z');
  expect(await marker(page)).toEqual([ids[0]]);
  await page.evaluate(() => {
    (window as any).__test.repo.restoreText = JSON.stringify({
      format: 'scratchtree-alpha',
      version: 7,
      exportedAt: '2026-11-12T00:00:00.000Z',
      library: { items: [], drafts: [], undoDeleteIds: [] },
    });
  });
  await page
    .getByRole('button', { name: 'Restore backup', exact: true })
    .click();
  expect(await workspaceZ(page)).toBe(false);
  await page
    .getByRole('button', { name: 'Cancel restore', exact: true })
    .click();
  await page.evaluate(() => (window as any).__test.delayCheckpoint());
  await capture(page).fill('pending draft');
  await page.evaluate(() => {
    const t = (window as any).__test;
    void t.controller.setNoteDone(
      t.repo.snapshot.items.find((x: any) => x.deletedAt === null).id,
      true,
    );
  });
  await expect
    .poll(() =>
      page.evaluate(() => (window as any).__test.controller.state.operation),
    )
    .toBe('completion');
  expect(await workspaceZ(page)).toBe(false);
  await page.evaluate(() => (window as any).__test.releaseCheckpoint());
  expect(await marker(page)).toEqual([ids[0]]);
});

test('capture, inline editor, and Search preserve text Undo and Shift Command-Z remains untouched', async ({
  page,
}) => {
  const ids = await deleted(page);
  await capture(page).fill('capture baseline');
  await capture(page).press('Meta+End');
  await page.keyboard.insertText(' appended');
  await capture(page).press('Meta+z');
  await expect(capture(page)).toHaveText('capture baseline');
  await capture(page).press('Meta+Shift+z');
  await expect(capture(page)).toHaveText('capture baseline appended');
  await card(page, ids[1]).dblclick();
  const edit = page.getByRole('textbox', { name: 'Edit Markdown' });
  await edit.press('Meta+End');
  await page.keyboard.insertText(' appended');
  await edit.press('Meta+z');
  await expect(edit).toHaveText('second surviving source');
  const search = page.getByRole('searchbox');
  await search.fill('');
  await search.press('a');
  await search.press('Meta+z');
  await expect(search).toHaveValue('');
  expect(await marker(page)).toEqual([ids[0]]);
});

test('failed workspace Undo keeps exact marker and draft; retrying command preserves newer Search focus', async ({
  page,
}) => {
  const ids = await deleted(page);
  await capture(page).fill('unsubmitted draft');
  await capture(page).press('Escape');
  await page.evaluate(() => {
    (window as any).__test.repo.fail = 'undo';
  });
  expect(await workspaceZ(page)).toBe(true);
  await expect(page.getByRole('alert')).toContainText('undo failure');
  expect(await marker(page)).toEqual([ids[0]]);
  await expect(capture(page)).toHaveText('unsubmitted draft');
  await page.evaluate(() => {
    const t = (window as any).__test;
    t.repo.fail = null;
    const original = t.repo.undoDelete.bind(t.repo);
    t.repo.undoDelete = async (request: any) => {
      await new Promise<void>((resolve) => {
        t.releaseUndo = resolve;
      });
      return original(request);
    };
  });
  expect(await workspaceZ(page)).toBe(true);
  await page.getByRole('searchbox').fill('newer search');
  await page.evaluate(() => (window as any).__test.releaseUndo());
  await expect.poll(() => marker(page)).toEqual([]);
  await expect(page.getByRole('searchbox')).toBeFocused();
  await expect(capture(page)).toHaveText('unsubmitted draft');
  expect(
    await page.evaluate(
      () => (window as any).__test.repo.snapshot.items.length,
    ),
  ).toBe(2);
});

test('capture save in progress leaves workspace Command-Z unhandled', async ({
  page,
}) => {
  const ids = await deleted(page);
  await page.evaluate(() => {
    const t = (window as any).__test;
    const original = t.repo.captureItem.bind(t.repo);
    t.repo.captureItem = async (...args: any[]) => {
      await new Promise<void>((resolve) => {
        t.releaseCapture = resolve;
      });
      return original(...args);
    };
  });
  await capture(page).fill('pending capture');
  await capture(page).press('Enter');
  await expect
    .poll(() =>
      page.evaluate(() => (window as any).__test.controller.state.operation),
    )
    .toBe('save');
  expect(await workspaceZ(page)).toBe(false);
  expect(await marker(page)).toEqual([ids[0]]);
  await page.evaluate(() => (window as any).__test.releaseCapture());
  await expect(capture(page)).toHaveText('');
});

test('Command-Z from Trash restores the exact marker without submitting its scoped draft', async ({
  page,
}) => {
  const ids = await deleted(page);
  await page.getByRole('button', { name: 'Trash', exact: true }).click();
  await capture(page).fill('Trash draft retained');
  await card(page, ids[0]).click();
  await page.keyboard.press('Meta+z');
  await expect(card(page, ids[0])).toHaveCount(0);
  await expect(capture(page)).toBeFocused();
  await expect(capture(page)).toHaveText('Trash draft retained');
  expect(await marker(page)).toEqual([]);
  expect(
    await page.evaluate(
      () => (window as any).__test.repo.snapshot.items.length,
    ),
  ).toBe(2);
});

test('pending workspace Undo accepts only one request across released Command-Z and the Undo button', async ({
  page,
}) => {
  const ids = await deleted(page);
  await capture(page).fill('unsubmitted pending Undo draft');
  await capture(page).press('Escape');
  await page.evaluate(() => {
    const t = (window as any).__test;
    const pending = new Promise<void>((resolve) => {
      t.releaseUndo = resolve;
    });
    const originalRequest = t.controller.undoRemove.bind(t.controller);
    const originalWrite = t.repo.undoDelete.bind(t.repo);
    t.undoRequests = 0;
    t.undoWrites = 0;
    t.controller.undoRemove = () => {
      t.undoRequests++;
      return originalRequest();
    };
    t.repo.undoDelete = async (request: any) => {
      t.undoWrites++;
      await pending;
      return originalWrite(request);
    };
  });
  expect(await workspaceZ(page)).toBe(true);
  await expect
    .poll(() => page.evaluate(() => (window as any).__test.undoWrites))
    .toBe(1);
  expect(await marker(page)).toEqual([ids[0]]);
  await expect(capture(page)).toHaveText('unsubmitted pending Undo draft');
  // A fresh keydown models a released/repressed shortcut, rather than auto-repeat.
  expect(await workspaceZ(page, { repeat: false })).toBe(false);
  const undo = page.getByRole('button', { name: 'Undo delete', exact: true });
  await expect(undo).toBeDisabled();
  await undo.dispatchEvent('click');
  expect(await page.evaluate(() => (window as any).__test.undoRequests)).toBe(
    1,
  );
  await page.getByRole('searchbox').fill('newer Search focus');
  await page.evaluate(async () => {
    const t = (window as any).__test;
    t.releaseUndo();
    await t.controller.flush();
  });
  await expect.poll(() => marker(page)).toEqual([]);
  expect(await page.evaluate(() => (window as any).__test.undoWrites)).toBe(1);
  await expect(page.getByRole('searchbox')).toBeFocused();
  await expect(page.getByRole('searchbox')).toHaveValue('newer Search focus');
  await expect(capture(page)).toHaveText('unsubmitted pending Undo draft');
  expect(
    await page.evaluate(
      () => (window as any).__test.repo.snapshot.items.length,
    ),
  ).toBe(2);
});
