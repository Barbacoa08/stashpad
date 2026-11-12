import { test, expect } from '@playwright/test';
for (const constrained of [false, true])
  test(`deep hierarchy preserves capture, ancestors, sidebar names, and owner activation; constrained=${constrained}`, async ({
    page,
  }) => {
    await page.setViewportSize(
      constrained ? { width: 800, height: 600 } : { width: 1440, height: 900 },
    );
    await page.goto('/?fixture');
    await page.getByRole('textbox', { name: 'Capture Markdown' }).waitFor();
    if (constrained)
      await page.addStyleTag({ content: ':root {font-size:24px !important}' });
    const fixture = await page.evaluate(async () => {
      const t = (window as any).__test;
      const s = {
        stashes: [] as any[],
        notes: [] as any[],
        drafts: [],
        undoDeleteId: null,
      };
      for (let i = 0; i < 40; i++) {
        const id = `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;
        s.stashes.push({
          id,
          name:
            `Level ${String(i + 1).padStart(2, '0')} ` +
            'long-name-'.repeat(19),
          parentId: s.stashes.at(-1)?.id ?? null,
          createdAt: i,
          updatedAt: i,
        });
      }
      const owner = s.stashes[38];
      for (let i = 0; i < 2; i++)
        s.notes.push({
          id: `00000000-0000-4001-8000-${String(i).padStart(12, '0')}`,
          stashId: owner.id,
          markdown: `match note ${i + 1}`,
          createdAt: 50 + i,
          updatedAt: 50 + i,
          done: false,
          deletedAt: null,
        });
      t.seedLegacy(s);
      await t.controller.start();
      await t.controller.openStash(owner.id);
      const label = (x: any) => ({
        ...x,
        name: Array.from(x.name).slice(0, 31).join('') + '…',
      });
      return {
        owner: label(owner),
        ancestor: label(s.stashes[16]),
        child: label(s.stashes[39]),
      };
    });
    const stream = page.getByRole('region', { name: 'Note stream' }),
      capture = page.getByRole('textbox', { name: 'Capture Markdown' });
    await expect(
      page.getByRole('navigation', { name: 'Breadcrumbs' }),
    ).toBeVisible();
    expect(
      await stream.evaluate((el) => el.getBoundingClientRect().height),
    ).toBeGreaterThanOrEqual(80);
    expect(
      await capture.evaluate((el) => {
        const r = el.getBoundingClientRect();
        return r.top >= 0 && r.bottom <= innerHeight;
      }),
    ).toBe(true);
    expect(
      await page
        .locator('.app-header h1')
        .evaluate((el) => Array.from(el.textContent ?? '').length),
    ).toBeLessThanOrEqual(96);
    const sidebar = page.getByRole('navigation', { name: 'Stashes' }),
      owner = sidebar.getByRole('button', {
        name: `Open stash ${fixture.owner.name}`,
        exact: true,
      });
    await owner.scrollIntoViewIfNeeded();
    expect(
      await owner
        .locator('.stash-name')
        .evaluate((el) => el.getBoundingClientRect().width),
    ).toBeGreaterThanOrEqual(40);
    await expect(owner.locator('svg[aria-hidden="true"]')).toHaveCount(1);
    const toggle = sidebar.getByRole('button', {
      name: `Collapse stash ${fixture.owner.name}`,
      exact: true,
    });
    expect(
      await toggle.evaluate((el) => {
        const r = el.getBoundingClientRect(),
          nav = el.closest('nav')!.getBoundingClientRect();
        return (
          r.width >= 20 &&
          r.height >= 20 &&
          r.left >= nav.left &&
          r.right <= nav.right
        );
      }),
    ).toBe(true);
    await toggle.click();
    await expect(
      sidebar.getByRole('button', {
        name: `Open stash ${fixture.child.name}`,
        exact: true,
      }),
    ).toHaveCount(0);
    await sidebar
      .getByRole('button', {
        name: `Expand stash ${fixture.owner.name}`,
        exact: true,
      })
      .click();
    await sidebar
      .getByRole('button', {
        name: `Open stash ${fixture.ancestor.name}`,
        exact: true,
      })
      .click();
    expect(
      await page.evaluate(
        () => (window as any).__test.controller.state.stashId,
      ),
    ).toBe(fixture.ancestor.id);
    await page.getByRole('searchbox').fill('match');
    const cards = page.getByRole('article', { name: 'Saved note' });
    await expect(cards).toHaveCount(2);
    expect(
      await cards
        .first()
        .locator('.note-location')
        .evaluate((el) => Array.from(el.textContent ?? '').length),
    ).toBeLessThanOrEqual(96);
    await cards.first().locator('.note-body').click();
    await page.keyboard.press('e');
    await expect(
      page.getByRole('textbox', { name: 'Edit Markdown' }),
    ).toHaveText('match note 1');
    expect(
      await page.evaluate(
        () => (window as any).__test.controller.state.stashId,
      ),
    ).toBe(fixture.ancestor.id);
    await expect(cards.first().locator('.stash-icon')).toHaveCount(0);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(constrained ? 800 : 1440);
  });

test('deep sidebar retains usable label and disclosure width at 800x600 and 150%', async ({
  page,
}) => {
  await page.setViewportSize({ width: 800, height: 600 });
  await page.goto('/?fixture');
  await page.getByRole('textbox', { name: 'Capture Markdown' }).waitFor();
  await page.addStyleTag({ content: ':root {font-size:24px !important}' });
  await page.evaluate(async () => {
    const t = (window as any).__test,
      s = { stashes: [] as any[], notes: [], drafts: [], undoDeleteId: null };
    for (let i = 0; i < 16; i++)
      s.stashes.push({
        id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
        name: `Deep stash ${i}`,
        parentId: s.stashes.at(-1)?.id ?? null,
        createdAt: i,
        updatedAt: i,
      });
    t.seedLegacy(s);
    await t.controller.start();
    await t.controller.openStash(s.stashes[14].id);
  });
  const button = page.getByRole('button', {
    name: 'Open stash Deep stash 14',
    exact: true,
  });
  await button.scrollIntoViewIfNeeded();
  expect(
    await button.evaluate((el) => el.getBoundingClientRect().width),
  ).toBeGreaterThanOrEqual(80);
});
