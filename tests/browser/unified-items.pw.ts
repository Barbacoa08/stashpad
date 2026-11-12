import { test, expect, type Page } from '@playwright/test';
const capture = (p: Page) =>
  p.getByRole('textbox', { name: 'Capture Markdown' });
const stream = (p: Page) => p.getByRole('region', { name: 'Note stream' });
const edit = (p: Page) => p.getByRole('textbox', { name: 'Edit Markdown' });
async function seed(p: Page, sources: string[]) {
  await p.goto('/?fixture');
  await capture(p).waitFor();
  return p.evaluate(async (sources) => {
    const t = (window as any).__test;
    const ids = [];
    for (const markdown of sources) {
      const id = crypto.randomUUID();
      ids.push(id);
      await t.repo.captureItem({
        id,
        location: { scope: 'live', itemId: null },
        markdown,
        draft: { key: 'compose', revision: 0 },
      });
    }
    await t.controller.start();
    return ids;
  }, sources);
}
test('selected note Command-N atomically preserves latest source and opens one child; stash Command-N adds to same selected parent', async ({
  page,
}) => {
  const [id] = await seed(page, ['**parent**\r\n']);
  const parent = page.locator(`[data-entry-id="${id}"]`);
  await parent.click();
  await page.keyboard.press('e');
  await edit(page).fill('latest **source**\r\n');
  await page.keyboard.press('Meta+n');
  await expect(capture(page)).toBeFocused();
  let items = await page.evaluate(
    () => (window as any).__test.repo.snapshot.items,
  );
  expect(items).toHaveLength(2);
  expect(items.find((x: any) => x.id === id)).toMatchObject({
    kind: 'stash',
    markdown: 'latest **source**\r\n',
    parentId: null,
    position: 0,
  });
  expect(items.find((x: any) => x.id !== id).parentId).toBe(id);
  await page.keyboard.press('Meta+1');
  await parent.click();
  await page.keyboard.press('Meta+n');
  await expect(capture(page)).toBeFocused();
  items = await page.evaluate(() => (window as any).__test.repo.snapshot.items);
  expect(items.filter((x: any) => x.parentId === id)).toHaveLength(2);
});
test('Right promotes unchanged ID, empty destinations focus capture, and stash double-click edits with E at end and retained Undo', async ({
  page,
}) => {
  const [id] = await seed(page, ['**source**']);
  let card = page.locator(`[data-entry-id="${id}"]`);
  await card.click();
  await page.keyboard.press('ArrowRight');
  await expect(capture(page)).toBeFocused();
  await page.keyboard.press('Meta+1');
  await card.dblclick();
  await expect(edit(page)).toHaveText('**source**');
  await edit(page).press('Meta+End');
  await page.keyboard.insertText(' appended');
  await edit(page).press('Escape');
  await stream(page).press('e');
  await page.keyboard.insertText('!');
  await expect(edit(page)).toHaveText('**source** appended!');
  await edit(page).press('Meta+z');
  await expect(edit(page)).toHaveText('**source** appended');
  await edit(page).press('Escape');
  expect(
    await page.evaluate(() => (window as any).__test.repo.snapshot.items[0].id),
  ).toBe(id);
});
test('mixed deletion selects same ordinal, preserves stash tree and edit histories, and Undo returns source', async ({
  page,
}) => {
  const ids = await seed(page, ['first', 'middle', 'last']);
  await page.evaluate(async (id) => {
    const t = (window as any).__test;
    await t.repo.promoteItem(id);
    await t.controller.start();
  }, ids[1]);
  const middle = page.locator(`[data-entry-id="${ids[1]}"]`);
  await middle.dblclick();
  await edit(page).press('Meta+End');
  await page.keyboard.insertText(' changed');
  await edit(page).press('Escape');
  await page.keyboard.press('Meta+Backspace');
  await expect(page.locator(`[data-entry-id="${ids[2]}"]`)).toHaveClass(
    /selected/,
  );
  await page.getByRole('button', { name: 'Undo delete', exact: true }).click();
  await middle.click();
  await page.keyboard.press('e');
  await expect(edit(page)).toHaveText('middle changed');
  await edit(page).press('Meta+z');
  await expect(edit(page)).toHaveText('middle');
});
test('blank stream background clears selection after flush; Command-N then uses current location, while composer Escape preserves a highlight', async ({
  page,
}) => {
  const [id] = await seed(page, ['parent']);
  const card = page.locator(`[data-entry-id="${id}"]`);
  await card.click();
  await page.keyboard.press('Space');
  await capture(page).press('Escape');
  await expect(card).toHaveClass(/selected/);
  await page.keyboard.press('e');
  await edit(page).fill('latest source');
  const box = (await stream(page).boundingBox())!;
  await stream(page).click({
    position: { x: box.width - 10, y: box.height - 10 },
  });
  await expect(card).not.toHaveClass(/selected/);
  await page.keyboard.press('Meta+n');
  await expect(capture(page)).toBeFocused();
  const items = await page.evaluate(
    () => (window as any).__test.repo.snapshot.items,
  );
  expect(items.find((x: any) => x.id === id)).toMatchObject({
    kind: 'note',
    markdown: 'latest source',
  });
  expect(items.find((x: any) => x.id !== id).parentId).toBeNull();
});

test('failed Delete has its own retry and keeps same ordinal focus without submitting capture', async ({
  page,
}) => {
  const ids = await seed(page, ['first', 'second']);
  await page.locator(`[data-entry-id="${ids[0]}"]`).click();
  await capture(page).fill('unsubmitted capture');
  await capture(page).press('Escape');
  await page.evaluate(() => ((window as any).__test.repo.fail = 'delete'));
  await page.keyboard.press('Meta+Backspace');
  await expect(
    page.getByRole('button', { name: 'Retry action', exact: true }),
  ).toBeVisible();
  await page.evaluate(() => ((window as any).__test.repo.fail = null));
  await page.getByRole('button', { name: 'Retry action', exact: true }).click();
  await expect(page.locator(`[data-entry-id="${ids[1]}"]`)).toHaveClass(
    /selected/,
  );
  await expect(stream(page)).toBeFocused();
  await expect(capture(page)).toHaveText('unsubmitted capture');
  expect(
    await page.evaluate(
      () => (window as any).__test.repo.snapshot.items.length,
    ),
  ).toBe(2);
});
test('selected global result becomes Command-N parent instead of the current open container', async ({
  page,
}) => {
  const ids = await seed(page, ['current owner', 'selected result']);
  await page.locator(`[data-entry-id="${ids[0]}"]`).click();
  await page.keyboard.press('ArrowRight');
  await page.getByRole('searchbox').fill('selected result');
  await page.locator(`[data-entry-id="${ids[1]}"]`).click();
  await page.keyboard.press('Meta+n');
  await expect(capture(page)).toBeFocused();
  const s = await page.evaluate(() => (window as any).__test.repo.snapshot);
  expect(s.items.find((x: any) => x.id === ids[1]).kind).toBe('stash');
  expect(s.items.find((x: any) => x.markdown === 'Untitled').parentId).toBe(
    ids[1],
  );
  expect(await page.getByRole('searchbox').inputValue()).toBe('');
});
test('deleting the open container through global search returns Home and retains its scoped draft for Undo', async ({
  page,
}) => {
  const [id] = await seed(page, ['current owner']);
  await page.locator(`[data-entry-id="${id}"]`).click();
  await page.keyboard.press('ArrowRight');
  await capture(page).fill('retained owner draft');
  await page.getByRole('searchbox').fill('current owner');
  await page.locator(`[data-entry-id="${id}"]`).click();
  await page.keyboard.press('Meta+Backspace');
  await expect(page.locator('h1')).toHaveText('Home');
  await expect(capture(page)).toBeFocused();
  await page.getByRole('button', { name: 'Undo delete', exact: true }).click();
  await page.getByRole('searchbox').press('Escape');
  await page.locator(`[data-entry-id="${id}"]`).click();
  await page.keyboard.press('ArrowRight');
  await expect(capture(page)).toHaveText('retained owner draft');
});
test('blank-background source flush preserves newer Search focus and query', async ({
  page,
}) => {
  const [id] = await seed(page, ['source']);
  await page.locator(`[data-entry-id="${id}"]`).dblclick();
  await edit(page).fill('latest');
  await page.evaluate(() => {
    const t = (window as any).__test;
    t.repo.delaySave = new Promise<void>(
      (resolve) => (t.releaseSave = resolve),
    );
  });
  const box = (await stream(page).boundingBox())!;
  await stream(page).click({
    position: { x: box.width - 10, y: box.height - 10 },
  });
  await page.getByRole('searchbox').fill('newer query');
  await page.evaluate(() => (window as any).__test.releaseSave());
  await expect(edit(page)).toHaveCount(0);
  await expect(page.getByRole('searchbox')).toBeFocused();
  await expect(page.getByRole('searchbox')).toHaveValue('newer query');
  expect(
    await page.evaluate(
      () => (window as any).__test.repo.snapshot.items[0].markdown,
    ),
  ).toBe('latest');
});
test('Capture Up follows displayed sibling rank, skips interleaved stashes, and uses displayed search order', async ({
  page,
}) => {
  const ids = await seed(page, ['match first-created', 'match second-created']);
  await page.evaluate(async (ids) => {
    const t = (window as any).__test;
    const stash = crypto.randomUUID();
    await t.repo.createChildStash({
      id: stash,
      parent: { scope: 'live', itemId: null },
    });
    await t.repo.saveItemSource(stash, 'match stash', {
      key: stash,
      revision: 0,
    });
    for (const x of t.repo.snapshot.items) {
      if (x.id === ids[0]) {
        x.position = 2;
        x.createdAt = 1;
        x.updatedAt = 1;
      } else if (x.id === ids[1]) {
        x.position = 0;
        x.createdAt = 2;
        x.updatedAt = 2;
      } else {
        x.position = 1;
        x.createdAt = 3;
        x.updatedAt = 3;
      }
    }
    await t.controller.start();
  }, ids);
  const entries = stream(page).getByRole('article');
  expect(
    await entries.evaluateAll((nodes) =>
      nodes.map((x) => x.getAttribute('data-entry-id')),
    ),
  ).toEqual([ids[1], expect.any(String), ids[0]]);
  await capture(page).fill('retained draft');
  await capture(page).press('Meta+Home');
  await capture(page).press('ArrowUp');
  await expect(page.locator(`[data-entry-id="${ids[0]}"]`)).toHaveClass(
    /selected/,
  );
  await expect(stream(page)).toBeFocused();
  await expect(capture(page)).toHaveText('retained draft');
  await page.getByRole('searchbox').fill('match');
  await capture(page).focus();
  await capture(page).press('Meta+Home');
  await capture(page).press('ArrowUp');
  await expect(page.locator(`[data-entry-id="${ids[1]}"]`)).toHaveClass(
    /selected/,
  );
  await expect(stream(page)).toBeFocused();
  await expect(page.getByRole('searchbox')).toHaveValue('match');
  await expect(capture(page)).toHaveText('retained draft');
});
for (const later of ['later source', 'original source'])
  test(`lost capture acknowledgment reconciles original ID while retaining newer editor source/revision: ${later}`, async ({
    page,
  }) => {
    await seed(page, []);
    await page.evaluate(() => {
      const t = (window as any).__test,
        capture = t.repo.captureItem.bind(t.repo);
      let lost = true;
      t.repo.captureItem = async (request: any) => {
        const result = await capture(request);
        if (lost) {
          lost = false;
          throw new Error('Synthetic lost acknowledgment');
        }
        return result;
      };
    });
    await capture(page).fill('original source');
    await capture(page).press('Enter');
    await expect(page.getByRole('alert')).toContainText(
      'Synthetic lost acknowledgment',
    );
    const original = await page.evaluate(
      () => (window as any).__test.repo.snapshot.items[0],
    );
    await capture(page).fill('temporary source');
    await capture(page).fill(later);
    const revision = await page.evaluate(
      () => (window as any).__test.controller.state.buffers.compose.revision,
    );
    await capture(page).press('Enter');
    await page.evaluate(() => (window as any).__test.controller.flush());
    await expect(capture(page)).toHaveText(later);
    const actual = await page.evaluate(() => {
      const t = (window as any).__test;
      return {
        items: t.repo.snapshot.items,
        buffer: t.controller.state.buffers.compose,
        draft: t.repo.snapshot.drafts.find((d: any) => d.key === 'compose'),
      };
    });
    expect(actual.items).toEqual([original]);
    expect(actual.buffer).toEqual({ source: later, revision });
    expect(actual.draft).toMatchObject({ markdown: later, revision });
  });
test('known absent capture after precommit capacity rejection accepts corrected editor source without workspace replacement', async ({
  page,
}) => {
  await seed(page, []);
  await page.evaluate(() => {
    const t = (window as any).__test,
      capture = t.repo.captureItem.bind(t.repo);
    let reject = true;
    t.repo.captureItem = async (request: any) => {
      if (reject) {
        reject = false;
        throw {
          code: 'capacity_exceeded',
          message: 'Synthetic precommit capacity rejection',
        };
      }
      return capture(request);
    };
  });
  await capture(page).fill('rejected capture source');
  await capture(page).press('Enter');
  await expect(page.getByRole('alert')).toContainText(
    'Synthetic precommit capacity rejection',
  );
  expect(
    await page.evaluate(() => (window as any).__test.repo.snapshot.items),
  ).toHaveLength(0);
  await expect(capture(page)).toHaveText('rejected capture source');
  await capture(page).fill('corrected capture source');
  await capture(page).press('Enter');
  await expect(capture(page)).toHaveText('');
  const items = await page.evaluate(
    () => (window as any).__test.repo.snapshot.items,
  );
  expect(items).toHaveLength(1);
  expect(items[0].markdown).toBe('corrected capture source');
});
