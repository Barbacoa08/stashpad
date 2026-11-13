import { test, expect } from '@playwright/test';

test('search leads navigation and status remains accessible in details', async ({
  page,
}) => {
  await page.goto('/?fixture');
  const sidebar = page.getByRole('complementary', {
    name: 'Workspace navigation',
  });
  const search = page.getByRole('searchbox', { name: 'Search saved notes' });
  await expect(search).toBeVisible();
  await expect(sidebar.locator('input, button').first()).toHaveAttribute(
    'id',
    'search',
  );
  await expect(sidebar.getByText('Search saved notes')).toHaveCount(1);
  await expect(
    sidebar
      .getByRole('button', { name: 'Root' })
      .locator('svg[aria-hidden=true]'),
  ).toHaveCount(1);
  await expect(
    page.getByRole('region', { name: 'Workspace status' }),
  ).toBeVisible();
  await expect(page.getByLabel('Keyboard shortcuts')).toContainText('New tree');
  await expect(page.getByLabel('Keyboard shortcuts')).toContainText('Space');
});

test('narrow details exposes failed save and retry without stealing focus', async ({
  page,
}) => {
  await page.setViewportSize({ width: 800, height: 600 });
  await page.goto('/?fixture');
  const capture = page.getByRole('textbox', { name: 'Capture Markdown' });
  await capture.waitFor();
  await page.evaluate(() => ((window as any).__test.repo.fail = 'save'));
  await capture.fill('Synthetic failed save');
  await capture.press('Enter');
  await expect(page.getByRole('alert')).toContainText('failure');
  await expect(capture).toBeFocused();
  await page.getByRole('button', { name: /Details/ }).click();
  await expect(page.getByRole('alert')).toContainText('failure');
  await page.evaluate(() => ((window as any).__test.repo.fail = null));
  await page.getByRole('button', { name: 'Retry save', exact: true }).click();
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect(page.getByRole('article', { name: 'Saved note' })).toContainText(
    'Synthetic failed save',
  );
});

for (const constrained of [false, true])
  test(`sidebar has one scroll surface and unified row at 150%=${constrained}`, async ({
    page,
  }) => {
    await page.setViewportSize(
      constrained ? { width: 800, height: 600 } : { width: 1440, height: 900 },
    );
    await page.goto('/?fixture');
    await page.getByRole('textbox', { name: 'Capture Markdown' }).waitFor();
    if (constrained)
      await page.addStyleTag({
        content: ':root { font-size: 24px !important }',
      });
    await page.evaluate(async () => {
      const t = (window as any).__test;
      const trees = Array.from({ length: 35 }, (_, i) => ({
        id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
        kind: 'tree',
        markdown: `Synthetic tree ${i} with long name`,
        parentId: i
          ? `00000000-0000-4000-8000-${String(i - 1).padStart(12, '0')}`
          : null,
        createdAt: i,
        updatedAt: i,
      }));
      t.seed({ items: trees, drafts: [], undoDeleteIds: [] });
      await t.controller.start();
      await t.controller.openTree(trees[33].id);
    });
    const sidebar = page.getByRole('complementary', {
      name: 'Workspace navigation',
    });
    const row = sidebar.locator('.tree-row.current');
    const title = row.getByRole('button', { name: /Open tree/ });
    const toggle = row.getByRole('button', { name: /Collapse tree/ });
    await title.focus();
    await expect(title).toBeFocused();
    const measurements = await row.evaluate((el) => {
      const r = el.getBoundingClientRect();
      const children = Array.from(el.querySelectorAll('button')).map((b) =>
        b.getBoundingClientRect(),
      );
      const side = el.closest('aside')!;
      const scrolls = [side, ...side.querySelectorAll('*')].filter((e) => {
        const style = getComputedStyle(e);
        return (
          /(auto|scroll)/.test(style.overflowY) &&
          e.scrollHeight > e.clientHeight + 1
        );
      });
      return {
        spans: children.every((c) => c.left >= r.left && c.right <= r.right),
        scrolls: scrolls.length,
        horizontal: side.scrollWidth > side.clientWidth + 1,
      };
    });
    expect(measurements).toEqual({
      spans: true,
      scrolls: 1,
      horizontal: false,
    });
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await toggle.press('Enter');
    await expect(
      row.getByRole('button', { name: /Expand tree/ }),
    ).toHaveAttribute('aria-expanded', 'false');
    await page.screenshot({
      path: `test-results/captures/sidebar/task-1-${constrained ? 'narrow-150' : 'wide'}.png`,
    });
  });

test('current and hovered tree rows retain one surface for both controls', async ({
  page,
  browserName,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/?fixture');
  await page.getByRole('textbox', { name: 'Capture Markdown' }).waitFor();
  await page.evaluate(async () => {
    const t = (window as any).__test;
    const names = ['Current', 'Current child', 'Other', 'Other child'];
    const trees = names.map((name, i) => ({
      id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
      kind: 'tree',
      markdown: name,
      parentId:
        i === 1
          ? '00000000-0000-4000-8000-000000000000'
          : i === 3
            ? '00000000-0000-4000-8000-000000000002'
            : null,
      createdAt: i,
      updatedAt: i,
    }));
    t.seed({ items: trees, drafts: [], undoDeleteIds: [] });
    await t.controller.start();
    await t.controller.openTree(trees[0].id);
  });
  for (const name of ['Current', 'Other']) {
    const title = page.getByRole('button', {
      name: `Open tree ${name}`,
      exact: true,
    });
    const row = title.locator('..');
    const chevron = row.getByRole('button', {
      name: new RegExp(`^(Expand|Collapse) tree ${name}$`),
    });
    for (const [part, target] of [
      ['title', title],
      ['chevron', chevron],
    ] as const) {
      await target.hover();
      await expect(row).toHaveCSS('background-color', 'rgb(48, 59, 79)');
      await expect(title).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
      await expect(chevron).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
      await page.screenshot({
        path: `test-results/captures/sidebar/task-1-hover-${name.toLowerCase()}-${part}.png`,
      });
    }
    await row.hover({ position: { x: 1, y: 1 } });
    await expect(row).toHaveCSS('background-color', 'rgb(48, 59, 79)');
    await expect(title).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
    await expect(chevron).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
  }
  const currentChevron = page.getByRole('button', {
    name: 'Collapse tree Current',
  });
  await currentChevron.focus();
  // WebKit uses Option-Tab to include buttons in sequential keyboard navigation.
  await page.keyboard.press(browserName === 'webkit' ? 'Alt+Tab' : 'Tab');
  const currentTitle = page.getByRole('button', {
    name: 'Open tree Current',
    exact: true,
  });
  await expect(currentTitle).toBeFocused();
  await expect(currentTitle).toHaveCSS('outline-style', 'solid');
});

async function failedCapture(
  page: import('@playwright/test').Page,
  width: number,
) {
  await page.setViewportSize({ width, height: 900 });
  await page.goto('/?fixture');
  const capture = page.getByRole('textbox', { name: 'Capture Markdown' });
  await capture.fill('Responsive recovery source');
  await page.evaluate(() => ((window as any).__test.repo.fail = 'save'));
  await capture.press('Enter');
  return capture;
}
test('responsive narrowing retains visible retry focus without changing source or error', async ({
  page,
}) => {
  const capture = await failedCapture(page, 1440);
  const retry = page.getByRole('button', { name: 'Retry save', exact: true });
  await retry.focus();
  await expect(retry).toBeFocused();
  const error = await page.getByRole('alert').textContent();
  await page.setViewportSize({ width: 800, height: 600 });
  const details = page.getByRole('button', { name: /Details/ });
  await expect(details).toHaveAttribute('aria-expanded', 'false');
  await expect(retry).toBeFocused();
  await expect(retry).toBeVisible();
  await expect(details).toBeVisible();
  await page.screenshot({
    path: 'test-results/captures/sidebar/final-fix-focus-narrow.png',
  });
  await expect(capture).toHaveText('Responsive recovery source');
  expect(
    await page.getByRole('alert', { includeHidden: true }).textContent(),
  ).toBe(error);
  expect(
    await page.evaluate(
      () =>
        (window as any).__test.repo.snapshot.items.filter(
          (x: any) => x.kind === 'note',
        ).length,
    ),
  ).toBe(0);
});
test('responsive widening retains focused Details disclosure while revealing its default panel', async ({
  page,
}) => {
  const capture = await failedCapture(page, 800);
  const details = page.getByRole('button', { name: /Details/ });
  await details.focus();
  await page.setViewportSize({ width: 1440, height: 900 });
  const panel = page.getByRole('complementary', { name: 'Note details' });
  await expect(panel).toBeVisible();
  await expect(details).toBeFocused();
  await expect(details).toHaveCSS('outline-style', 'solid');
  await page.screenshot({
    path: 'test-results/captures/sidebar/final-fix-focus-wide.png',
  });
  await expect(capture).toHaveText('Responsive recovery source');
  await expect(page.getByRole('alert')).toContainText('failure');
});
test('responsive changes and explicit close retain visible recovery focus', async ({
  page,
}) => {
  await failedCapture(page, 800);
  const details = page.getByRole('button', { name: /Details/ });
  await details.click();
  const retry = page.getByRole('button', { name: 'Retry save', exact: true });
  await retry.focus();
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(retry).toBeFocused();
  await page.setViewportSize({ width: 800, height: 600 });
  await expect(retry).toBeFocused();
  await expect(retry).toBeVisible();
  await details.dispatchEvent('click');
  await expect(details).toHaveAttribute('aria-expanded', 'false');
  await expect(retry).toBeFocused();
  await expect(retry).toBeVisible();
});
test('responsive changes never steal newer unrelated Search or capture focus', async ({
  page,
}) => {
  const capture = await failedCapture(page, 1440);
  const retry = page.getByRole('button', { name: 'Retry save', exact: true });
  const search = page.getByRole('searchbox');
  await retry.focus();
  await search.focus();
  await page.setViewportSize({ width: 800, height: 600 });
  await expect(search).toBeFocused();
  await capture.focus();
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(capture).toBeFocused();
  await page.setViewportSize({ width: 800, height: 600 });
  await search.focus();
  await page.waitForTimeout(30);
  await expect(search).toBeFocused();
  await expect(capture).toHaveText('Responsive recovery source');
});
