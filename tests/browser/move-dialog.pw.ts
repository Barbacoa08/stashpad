import { test, expect, type Page } from '@playwright/test';
const card = (page: Page, id: string) =>
  page.locator(`[data-entry-id="${id}"]`);
const capture = (page: Page) =>
  page.getByRole('textbox', { name: 'Capture Markdown' });
async function seed(page: Page) {
  await page.goto('/?fixture');
  await capture(page).waitFor();
  return page.evaluate(async () => {
    const t = (window as any).__test;
    const ids = Array.from({ length: 4 }, () => crypto.randomUUID());
    for (const [index, markdown] of [
      'move source',
      'destination alpha',
      'destination beta',
    ].entries())
      await t.repo.captureItem({
        id: ids[index],
        location: { scope: 'live', itemId: null },
        markdown,
        draft: { key: 'compose', revision: 0 },
      });
    await t.repo.createChildStash({
      id: ids[3],
      parent: { scope: 'live', itemId: ids[1] },
    });
    await t.repo.promoteItem(ids[2]);
    await t.controller.start();
    return ids;
  });
}
async function snapshot(page: Page) {
  return page.evaluate(() =>
    structuredClone((window as any).__test.repo.snapshot),
  );
}

test('live M offers Trash, stages without writing, and cancels neutrally', async ({
  page,
}) => {
  const ids = await seed(page);
  await card(page, ids[0]).click();
  const before = await snapshot(page);
  await page.keyboard.press('m');
  const dialog = page.getByRole('dialog', { name: 'Move items' });
  const trash = dialog.getByRole('option', { name: 'Trash', exact: true });
  await expect(trash).toBeVisible();
  await trash.click();
  await expect(trash).toHaveAttribute('aria-selected', 'true');
  expect(await snapshot(page)).toEqual(before);
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect(await snapshot(page)).toEqual(before);
});

test('M stages destinations without writing, traps focus, and cancels from Escape and backdrop', async ({
  page,
}) => {
  const ids = await seed(page);
  await card(page, ids[0]).click();
  const before = await snapshot(page);
  await page.keyboard.press('m');
  const dialog = page.getByRole('dialog', { name: 'Move items' });
  await expect(dialog).toBeVisible();
  const list = dialog.getByRole('listbox', { name: 'Destination' });
  await expect(list).toBeFocused();
  await dialog
    .getByRole('option', { name: 'destination alpha, Home', exact: true })
    .click();
  expect(await snapshot(page)).toEqual(before);
  await page.keyboard.press('ArrowDown');
  expect(await snapshot(page)).toEqual(before);
  await page.keyboard.press('Tab');
  await expect(
    dialog.getByRole('button', { name: 'Cancel', exact: true }),
  ).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(
    dialog.getByRole('button', { name: 'Move', exact: true }),
  ).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(list).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(
    dialog.getByRole('button', { name: 'Move', exact: true }),
  ).toBeFocused();
  expect(
    await dialog.evaluate((element) =>
      element.contains(document.activeElement),
    ),
  ).toBe(true);
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole('region', { name: 'Note stream' })).toBeFocused();
  await page.keyboard.press('m');
  await page.mouse.click(2, 2);
  await expect(dialog).toHaveCount(0);
  expect(await snapshot(page)).toEqual(before);
});

test('Enter confirms the captured selected source block once and excludes selected descendants as destinations', async ({
  page,
}) => {
  const ids = await seed(page);
  await card(page, ids[0]).click();
  await card(page, ids[1]).click({ modifiers: ['Meta'] });
  await page.keyboard.press('m');
  const dialog = page.getByRole('dialog', { name: 'Move items' });
  await expect(
    dialog.getByRole('option', {
      name: 'destination alpha, Home',
      exact: true,
    }),
  ).toHaveCount(0);
  await dialog
    .getByRole('option', { name: 'destination beta, Home', exact: true })
    .click();
  await page.keyboard.press('Enter');
  await expect(dialog).toHaveCount(0);
  await expect
    .poll(async () =>
      (await snapshot(page)).items
        .filter((item: any) => item.parentId === ids[2])
        .sort((a: any, b: any) => a.position - b.position)
        .map((item: any) => item.id),
    )
    .toEqual(ids.slice(0, 2));
  expect(
    (await snapshot(page)).items.find((item: any) => item.id === ids[3])
      .parentId,
  ).toBe(ids[1]);
});

test('failed modal movement retains the exact destination for Retry and ignores later staging', async ({
  page,
}) => {
  const ids = await seed(page);
  await card(page, ids[0]).click();
  await page.keyboard.press('m');
  const dialog = page.getByRole('dialog', { name: 'Move items' });
  await dialog
    .getByRole('option', { name: 'destination alpha, Home', exact: true })
    .click();
  await page.evaluate(() => {
    (window as any).__test.repo.fail = 'move';
  });
  await dialog.getByRole('button', { name: 'Move', exact: true }).click();
  await expect(
    dialog.getByRole('button', { name: 'Retry move', exact: true }),
  ).toBeVisible();
  await expect(
    dialog.getByRole('option', { name: 'destination beta, Home', exact: true }),
  ).toBeDisabled();
  await dialog
    .getByRole('option', { name: 'destination beta, Home', exact: true })
    .dispatchEvent('click');
  await dialog.getByRole('listbox', { name: 'Destination' }).focus();
  await page.keyboard.press('ArrowDown');
  await expect(
    dialog.getByRole('option', {
      name: 'destination alpha, Home',
      exact: true,
    }),
  ).toHaveAttribute('aria-selected', 'true');
  await page.evaluate(() => {
    (window as any).__test.repo.fail = null;
  });
  await dialog.getByRole('button', { name: 'Retry move', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect
    .poll(
      async () =>
        (await snapshot(page)).items.find((item: any) => item.id === ids[0])
          .parentId,
    )
    .toBe(ids[1]);
});

test('pending modal movement commits once and cannot be presented as cancelled', async ({
  page,
}) => {
  const ids = await seed(page);
  await card(page, ids[0]).click();
  await page.evaluate(() => {
    const t = (window as any).__test,
      move = t.repo.moveItems.bind(t.repo);
    t.moveCalls = 0;
    t.repo.moveItems = async (request: any) => {
      t.moveCalls++;
      await new Promise<void>((release) => {
        t.releaseMove = release;
      });
      return move(request);
    };
  });
  await page.keyboard.press('m');
  const dialog = page.getByRole('dialog', { name: 'Move items' });
  await dialog
    .getByRole('option', { name: 'destination alpha, Home', exact: true })
    .click();
  await page.keyboard.press('Enter');
  await expect(
    dialog.getByRole('button', { name: 'Moving…', exact: true }),
  ).toBeDisabled();
  await page.keyboard.press('Escape');
  await page.keyboard.press('Enter');
  await expect(dialog).toBeVisible();
  expect(await page.evaluate(() => (window as any).__test.moveCalls)).toBe(1);
  await page.evaluate(() => (window as any).__test.releaseMove());
  await expect(dialog).toHaveCount(0);
  await expect
    .poll(
      async () =>
        (await snapshot(page)).items.find((item: any) => item.id === ids[0])
          .parentId,
    )
    .toBe(ids[1]);
});

for (const scale of [100, 150])
  test(`destination dialog stays reachable with long labels at ${scale}% text`, async ({
    page,
  }) => {
    await page.setViewportSize({
      width: scale === 100 ? 1440 : 800,
      height: scale === 100 ? 900 : 600,
    });
    const ids = await seed(page);
    await page.evaluate(async (id) => {
      const t = (window as any).__test;
      t.repo.snapshot.items.find((item: any) => item.id === id).markdown =
        'A destination with a deliberately long synthetic first line '.repeat(
          8,
        );
      await t.controller.start();
    }, ids[1]);
    if (scale === 150)
      await page.addStyleTag({ content: ':root{font-size:24px !important}' });
    await card(page, ids[0]).click();
    await page.keyboard.press('m');
    const dialog = page.getByRole('dialog', { name: 'Move items' });
    await expect(dialog).toBeVisible();
    await expect(
      dialog.getByRole('button', { name: 'Move', exact: true }),
    ).toBeInViewport();
    const bounds = (await dialog.boundingBox())!;
    for (const name of ['Cancel', 'Move']) {
      const button = (await dialog
        .getByRole('button', { name, exact: true })
        .boundingBox())!;
      expect(button.y).toBeGreaterThanOrEqual(bounds.y + 1);
      expect(button.y + button.height).toBeLessThanOrEqual(
        bounds.y + bounds.height - 1,
      );
    }
    expect(bounds.x).toBeGreaterThanOrEqual(0);
    expect(bounds.y).toBeGreaterThanOrEqual(0);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(
      scale === 100 ? 1440 : 800,
    );
    expect(bounds.y + bounds.height).toBeLessThanOrEqual(
      scale === 100 ? 900 : 600,
    );
    await page.screenshot({
      path: test.info().outputPath(`move-dialog-${scale}.png`),
    });
  });

test('a stale staged destination explains the failure inside the modal without moving source', async ({
  page,
}) => {
  const ids = await seed(page);
  await card(page, ids[0]).click();
  await page.keyboard.press('m');
  const dialog = page.getByRole('dialog', { name: 'Move items' });
  await dialog
    .getByRole('option', { name: 'destination alpha, Home', exact: true })
    .click();
  await page.evaluate(async (id) => {
    const t = (window as any).__test;
    await t.repo.deleteItem(id);
    await t.controller.start();
  }, ids[1]);
  await dialog.getByRole('button', { name: 'Move', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('destination');
  expect(
    (await snapshot(page)).items.find((item: any) => item.id === ids[0])
      .parentId,
  ).toBeNull();
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(dialog).toHaveCount(0);
});

test('Trash movement offers both roots and moves directly to Home', async ({
  page,
}) => {
  const ids = await seed(page);
  await page.evaluate(async (ids) => {
    const t = (window as any).__test;
    for (const id of ids.slice(0, 3)) await t.repo.deleteItem(id);
    await t.controller.start();
  }, ids);
  await page.getByRole('button', { name: 'Trash', exact: true }).click();
  await card(page, ids[0]).click();
  await page.keyboard.press('m');
  const dialog = page.getByRole('dialog', { name: 'Move items' });
  await expect(
    dialog.getByRole('option', { name: 'Home', exact: true }),
  ).toBeVisible();
  await expect(
    dialog.getByRole('option', { name: 'Trash', exact: true }),
  ).toBeVisible();
  await dialog
    .getByRole('option', { name: 'destination alpha, Trash', exact: true })
    .click();
  await dialog.getByRole('button', { name: 'Move', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect
    .poll(
      async () =>
        (await snapshot(page)).items.find((item: any) => item.id === ids[0])
          .parentId,
    )
    .toBe(ids[1]);
  await card(page, ids[1]).click();
  await page.keyboard.press('ArrowRight');
  await card(page, ids[0]).click();
  await page.keyboard.press('m');
  await dialog.getByRole('option', { name: 'Home', exact: true }).click();
  await dialog.getByRole('button', { name: 'Move', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await page.getByRole('button', { name: 'Home', exact: true }).click();
  await expect(card(page, ids[0])).toBeVisible();
});

test('duplicate destination names expose their ancestry, stage without writing, and Enter moves to the chosen exact owner', async ({
  page,
}) => {
  const ids = await seed(page);
  const duplicates = await page.evaluate(async (ids) => {
    const t = (window as any).__test;
    const duplicates = [crypto.randomUUID(), crypto.randomUUID()];
    for (const [index, id] of duplicates.entries()) {
      await t.repo.createChildStash({
        id,
        parent: { scope: 'live', itemId: ids[index + 1] },
      });
      await t.repo.saveItemSource(id, 'Shared destination', {
        key: id,
        revision: 1,
      });
    }
    await t.controller.start();
    return duplicates;
  }, ids);
  await card(page, ids[0]).click();
  const before = await snapshot(page);
  await page.keyboard.press('m');
  const dialog = page.getByRole('dialog', { name: 'Move items' });
  const alpha = dialog.getByRole('option', {
    name: 'Shared destination, Home / destination alpha',
    exact: true,
  });
  const beta = dialog.getByRole('option', {
    name: 'Shared destination, Home / destination beta',
    exact: true,
  });
  await expect(alpha).toBeVisible();
  await expect(beta).toBeVisible();
  await beta.click();
  await expect(beta).toHaveAttribute('aria-selected', 'true');
  expect(await snapshot(page)).toEqual(before);
  await page.keyboard.press('Enter');
  await expect(dialog).toHaveCount(0);
  await expect
    .poll(
      async () =>
        (await snapshot(page)).items.find((item: any) => item.id === ids[0])
          .parentId,
    )
    .toBe(duplicates[1]);
  expect(
    (await snapshot(page)).items.find((item: any) => item.id === duplicates[0])
      .parentId,
  ).toBe(ids[1]);
});

test('one Command-Z restores a noncontiguous M-to-Trash group in original order and selects only its first visible item', async ({
  page,
}) => {
  const ids = await seed(page);
  const before = await snapshot(page);
  await card(page, ids[0]).click();
  await card(page, ids[2]).click({ modifiers: ['Meta'] });
  await page.keyboard.press('m');
  const dialog = page.getByRole('dialog', { name: 'Move items' });
  await dialog.getByRole('option', { name: 'Trash', exact: true }).click();
  await page.keyboard.press('Enter');
  await expect(dialog).toHaveCount(0);
  await expect(card(page, ids[0])).toHaveCount(0);
  await expect(card(page, ids[2])).toHaveCount(0);
  expect((await snapshot(page)).undoDeleteIds).toEqual([ids[0], ids[2]]);
  await page.keyboard.press('Meta+z');
  await expect(card(page, ids[0])).toHaveClass(/selected/);
  await expect(card(page, ids[2])).not.toHaveClass(/selected/);
  await expect(page.locator('.note-card.selected')).toHaveCount(1);
  await expect(page.getByRole('region', { name: 'Note stream' })).toBeFocused();
  const after = await snapshot(page);
  expect(after.undoDeleteIds).toEqual([]);
  const retained = (s: any) =>
    s.items.map(({ updatedAt, ...item }: any) => item);
  expect(retained(after)).toEqual(retained(before));
  expect(after.drafts).toEqual(before.drafts);
  expect(
    await page.evaluate(() => (window as any).__test.controller.state.location),
  ).toEqual({ scope: 'live', itemId: null });
});

test('both-area duplicate destinations expose their scoped paths and restoring a parent leaves independent deleted descendants in Trash', async ({
  page,
}) => {
  const ids = await seed(page);
  const independent = await page.evaluate(async (ids) => {
    const t = (window as any).__test;
    await t.repo.saveItemSource(ids[1], 'Shared destination', {
      key: ids[1],
      revision: 1,
    });
    await t.repo.saveItemSource(ids[2], 'Shared destination', {
      key: ids[2],
      revision: 1,
    });
    await t.repo.deleteItem(ids[1]);
    await t.repo.deleteItem(ids[0]);
    const independent = crypto.randomUUID();
    await t.repo.captureItem({
      id: independent,
      location: { scope: 'trash', itemId: ids[1] },
      markdown: 'independent record',
      draft: { key: `compose:${ids[1]}`, revision: 0 },
    });
    await t.repo.deleteItem(independent);
    // A same-area move keeps this independent deletion explicitly beneath its parent.
    await t.controller.start();
    const request = t.controller.captureMove(
      [independent],
      { scope: 'trash', itemId: ids[1] },
      1,
    );
    await t.controller.moveItems(request);
    return independent;
  }, ids);
  await page.getByRole('button', { name: 'Trash', exact: true }).click();
  await card(page, ids[0]).click();
  await page.keyboard.press('m');
  const dialog = page.getByRole('dialog', { name: 'Move items' });
  await expect(
    dialog.getByRole('option', {
      name: 'Shared destination, Home',
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    dialog.getByRole('option', {
      name: 'Shared destination, Trash',
      exact: true,
    }),
  ).toBeVisible();
  await page.keyboard.press('Escape');
  await card(page, ids[1]).click();
  await page.keyboard.press('m');
  await expect(
    dialog.getByRole('option', {
      name: 'Untitled, Trash / Shared destination',
      exact: true,
    }),
  ).toHaveCount(0);
  await dialog
    .getByRole('option', { name: 'Shared destination, Home', exact: true })
    .click();
  await page.keyboard.press('Enter');
  await expect(dialog).toHaveCount(0);
  await expect(card(page, independent)).toBeVisible();
  const state = await snapshot(page);
  expect(state.items.find((item: any) => item.id === ids[1])).toMatchObject({
    parentId: ids[2],
    deletedAt: null,
    restoreParentId: null,
    restoreIndex: null,
  });
  expect(state.items.find((item: any) => item.id === ids[3])).toMatchObject({
    parentId: ids[1],
    deletedAt: null,
  });
  expect(
    state.items.find((item: any) => item.id === independent),
  ).toMatchObject({ parentId: null });
  expect(
    state.items.find((item: any) => item.id === independent).deletedAt,
  ).not.toBeNull();
});

test('cross-area lost acknowledgment retries the exact move without replacing a newer deletion group', async ({
  page,
}) => {
  const ids = await seed(page);
  await page.evaluate(() => {
    const t = (window as any).__test,
      move = t.repo.moveItems.bind(t.repo);
    t.moveCalls = 0;
    t.repo.moveItems = async (request: any) => {
      const result = await move(request);
      if (++t.moveCalls === 1)
        throw new Error('Synthetic lost cross-area acknowledgment');
      return result;
    };
  });
  await card(page, ids[0]).click();
  await page.keyboard.press('m');
  const dialog = page.getByRole('dialog', { name: 'Move items' });
  await dialog.getByRole('option', { name: 'Trash', exact: true }).click();
  await page.keyboard.press('Enter');
  await expect(dialog.getByRole('alert')).toContainText(
    'lost cross-area acknowledgment',
  );
  const committed = (await snapshot(page)).items.find(
    (item: any) => item.id === ids[0],
  );
  await page.evaluate(async (id) => {
    const t = (window as any).__test;
    await t.repo.deleteItem(id);
  }, ids[3]);
  await dialog.getByRole('button', { name: 'Retry move', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  const state = await snapshot(page);
  expect(state.items.find((item: any) => item.id === ids[0])).toEqual(
    committed,
  );
  expect(state.undoDeleteIds).toEqual([ids[3]]);
});

for (const newerSelection of [false, true])
  test(`failed group Undo retries all captured roots and respects selection ownership; newerSelection=${newerSelection}`, async ({
    page,
  }) => {
    const ids = await seed(page);
    await card(page, ids[0]).click();
    await card(page, ids[2]).click({ modifiers: ['Meta'] });
    await page.keyboard.press('m');
    const dialog = page.getByRole('dialog', { name: 'Move items' });
    await dialog.getByRole('option', { name: 'Trash', exact: true }).click();
    await page.keyboard.press('Enter');
    await expect(dialog).toHaveCount(0);
    await page.evaluate(() => {
      (window as any).__test.repo.fail = 'undo';
    });
    await page.keyboard.press('Meta+z');
    await expect(page.getByRole('alert')).toContainText('undo failure');
    expect((await snapshot(page)).undoDeleteIds).toEqual([ids[0], ids[2]]);
    await expect(card(page, ids[0])).toHaveCount(0);
    await expect(card(page, ids[2])).toHaveCount(0);
    await page.evaluate(() => {
      (window as any).__test.repo.fail = null;
    });
    if (newerSelection) await card(page, ids[1]).click();
    await page
      .getByRole('button', { name: 'Retry action', exact: true })
      .click();
    await expect(card(page, ids[newerSelection ? 1 : 0])).toHaveClass(
      /selected/,
    );
    await expect(card(page, ids[2])).toBeVisible();
    expect((await snapshot(page)).undoDeleteIds).toEqual([]);
  });

test('current backup round trip retains one persistent group Undo action', async ({
  page,
}) => {
  const ids = await seed(page);
  await card(page, ids[0]).click();
  await card(page, ids[2]).click({ modifiers: ['Meta'] });
  await page.keyboard.press('m');
  const dialog = page.getByRole('dialog', { name: 'Move items' });
  await dialog.getByRole('option', { name: 'Trash', exact: true }).click();
  await page.keyboard.press('Enter');
  await expect(dialog).toHaveCount(0);
  await page
    .getByRole('button', { name: 'Export backup', exact: true })
    .click();
  const backup = await page.evaluate(() =>
    JSON.parse((window as any).__test.repo.exported),
  );
  expect(backup.version).toBe(6);
  expect(backup.workspace.undoDeleteIds).toEqual([ids[0], ids[2]]);
  expect(backup.workspace).not.toHaveProperty('undoDeleteId');
  await page.evaluate(() => {
    const t = (window as any).__test;
    t.repo.restoreText = t.repo.exported;
  });
  await page
    .getByRole('button', { name: 'Restore backup', exact: true })
    .click();
  await page
    .getByRole('button', { name: 'Replace workspace', exact: true })
    .click();
  await capture(page).press('Escape');
  await page.keyboard.press('Meta+z');
  await expect(card(page, ids[0])).toHaveClass(/selected/);
  await expect(card(page, ids[2])).toBeVisible();
  expect((await snapshot(page)).undoDeleteIds).toEqual([]);
});

test('pending group Undo Retry shares the shortcut and button guard and preserves newer Search focus', async ({
  page,
}) => {
  const ids = await seed(page);
  await card(page, ids[0]).click();
  await card(page, ids[2]).click({ modifiers: ['Meta'] });
  await page.keyboard.press('m');
  const dialog = page.getByRole('dialog', { name: 'Move items' });
  await dialog.getByRole('option', { name: 'Trash', exact: true }).click();
  await page.keyboard.press('Enter');
  await expect(dialog).toHaveCount(0);
  await page.evaluate(() => {
    (window as any).__test.repo.fail = 'undo';
  });
  await page.keyboard.press('Meta+z');
  await expect(page.getByRole('alert')).toContainText('undo failure');
  await page.evaluate(() => {
    const t = (window as any).__test,
      undo = t.repo.undoDelete.bind(t.repo);
    t.repo.fail = null;
    t.undoRequests = [];
    t.repo.undoDelete = async (request: any) => {
      t.undoRequests.push(structuredClone(request));
      await new Promise<void>((release) => {
        t.releaseUndo = release;
      });
      return undo(request);
    };
  });
  await page.getByRole('button', { name: 'Retry action', exact: true }).click();
  await expect
    .poll(() => page.evaluate(() => (window as any).__test.undoRequests.length))
    .toBe(1);
  await expect(
    page.getByRole('button', { name: 'Undo delete', exact: true }),
  ).toBeDisabled();
  const prevented = await page
    .getByRole('region', { name: 'Note stream' })
    .evaluate((node) => {
      const event = new KeyboardEvent('keydown', {
        key: 'z',
        metaKey: true,
        bubbles: true,
        cancelable: true,
      });
      node.dispatchEvent(event);
      return event.defaultPrevented;
    });
  expect(prevented).toBe(false);
  await page.getByRole('searchbox').fill('destination alpha');
  await page.evaluate(() => (window as any).__test.releaseUndo());
  await expect
    .poll(async () => (await snapshot(page)).undoDeleteIds)
    .toEqual([]);
  await expect(page.getByRole('searchbox')).toBeFocused();
  await expect(page.getByRole('searchbox')).toHaveValue('destination alpha');
  const requests = await page.evaluate(
    () => (window as any).__test.undoRequests,
  );
  expect(requests).toHaveLength(1);
  expect(requests[0].ids).toEqual([ids[0], ids[2]]);
});
