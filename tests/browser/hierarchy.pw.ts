import { test, expect, type Page } from '@playwright/test';
const capture = (page: Page) =>
  page.getByRole('textbox', { name: 'Capture Markdown' });
async function create(page: Page, name: string) {
  await expect(capture(page)).toBeVisible();
  await page.keyboard.press('Meta+n');
  const dialog = page.getByRole('dialog', { name: 'New stash' });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('textbox', { name: 'Stash name' }).fill(name);
  await dialog.getByRole('textbox', { name: 'Stash name' }).press('Enter');
  await expect(dialog).toBeHidden();
}
test('Command N preserves editor draft, creates nested stashes, captures there, and global search identifies ownership', async ({
  page,
}) => {
  await page.goto('/?fixture');
  await capture(page).fill('Home draft');
  await create(page, 'Projects');
  await expect(page.locator('.app-header h1')).toContainText('Projects');
  await capture(page).fill('Parent draft');
  await create(page, 'Ideas');
  await capture(page).fill('Nested **source**');
  await capture(page).press('Enter');
  await expect(page.getByRole('article', { name: 'Saved note' })).toContainText(
    'Nested source',
  );
  await expect(capture(page)).toHaveText('');
  await capture(page).fill('Next nested capture');
  await page
    .getByRole('button', { name: 'Open stash Projects', exact: true })
    .click();
  await expect(capture(page)).toHaveText('Parent draft');
  await page.getByRole('button', { name: 'Home', exact: true }).first().click();
  await expect(capture(page)).toHaveText('Home draft');
  const stash = page.getByRole('article', { name: 'Stash Projects' });
  await stash.click();
  await page.keyboard.press('Enter');
  await expect(page.locator('.app-header h1')).toContainText('Projects');
  await page.getByRole('article', { name: 'Stash Ideas' }).dblclick();
  await expect(capture(page)).toHaveText('Next nested capture');
  await page.getByRole('button', { name: 'Home', exact: true }).first().click();
  await page.getByRole('searchbox').fill('Nested **source**');
  const note = page.getByRole('article', { name: 'Saved note' });
  await expect(note).toContainText('Home / Projects / Ideas');
  await note.click();
  await page.keyboard.press('e');
  await expect(page.getByRole('textbox', { name: 'Edit Markdown' })).toHaveText(
    'Nested **source**',
  );
  await page.keyboard.press('Escape');
  expect(
    await page.evaluate(
      () => (window as any).__test.repo.snapshot.notes[0].stashId,
    ),
  ).toBe(
    await page.evaluate(() => (window as any).__test.controller.state.stashId),
  );
});
test('name validation, Escape focus, rename, and stash-only controls are truthful', async ({
  page,
}) => {
  await page.goto('/?fixture');
  await capture(page).fill('Retained');
  await page.keyboard.press('Meta+n');
  let dialog = page.getByRole('dialog', { name: 'New stash' });
  await dialog.getByRole('textbox', { name: 'Stash name' }).fill('  ');
  await dialog.getByRole('textbox', { name: 'Stash name' }).press('Enter');
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('alert')).toContainText('1 to 200');
  await page.keyboard.press('Escape');
  await expect(capture(page)).toBeFocused();
  await expect(capture(page)).toHaveText('Retained');
  await create(page, 'Named');
  await page.getByRole('button', { name: 'Home', exact: true }).first().click();
  const stash = page.getByRole('article', { name: 'Stash Named' });
  await stash.click();
  await expect(stash.getByRole('button', { name: 'Delete note' })).toHaveCount(
    0,
  );
  await expect(
    stash.getByRole('button', { name: 'Copy Markdown' }),
  ).toHaveCount(0);
  await expect(stash.locator('svg')).toBeVisible();
  await stash.getByRole('button', { name: 'Rename stash' }).click();
  dialog = page.getByRole('dialog', { name: 'Rename stash' });
  await dialog.getByRole('textbox', { name: 'Stash name' }).fill('Renamed');
  await dialog.getByRole('textbox', { name: 'Stash name' }).press('Enter');
  await expect(
    page.getByRole('article', { name: 'Stash Renamed' }),
  ).toBeVisible();
});
test('per-location capture caret and undo survive navigation', async ({
  page,
}) => {
  await page.goto('/?fixture');
  await capture(page).focus();
  await page.keyboard.insertText('Home');
  await page.keyboard.press('ArrowLeft');
  await create(page, 'Away');
  await capture(page).focus();
  await page.keyboard.insertText('Away draft');
  await page.getByRole('button', { name: 'Home', exact: true }).first().click();
  await page.keyboard.press('Space');
  await expect(capture(page)).toBeFocused();
  await page.keyboard.insertText('X');
  await expect(capture(page)).toHaveText('HomXe');
  await page.keyboard.press('Meta+z');
  await expect(capture(page)).toHaveText('Home');
  await page
    .getByRole('button', { name: 'Open stash Away', exact: true })
    .click();
  await expect(capture(page)).toHaveText('Away draft');
});

test('search location stays inside its note card and cancellation restores editor selection', async ({
  page,
}) => {
  await page.goto('/?fixture');
  await capture(page).fill('Retained');
  await capture(page).press('Home');
  await capture(page).press('ArrowRight');
  await capture(page).press('ArrowRight');
  await page.keyboard.press('Meta+n');
  await page.getByRole('textbox', { name: 'Stash name' }).press('Escape');
  await page.keyboard.insertText('X');
  await expect(capture(page)).toHaveText('ReXtained');
  await create(page, 'Parent with a long meaningful name');
  await create(page, 'Child with another descriptive name');
  await capture(page).fill('Nested source');
  await capture(page).press('Enter');
  await page.getByRole('button', { name: 'Home', exact: true }).first().click();
  await page.getByRole('searchbox').fill('Nested');
  const note = page.getByRole('article', { name: 'Saved note' });
  expect(
    await note.evaluate((el) => {
      const card = el.getBoundingClientRect(),
        label = el.querySelector('.note-location')!.getBoundingClientRect();
      return (
        label.top >= card.top &&
        label.bottom <= card.bottom &&
        label.left >= card.left &&
        label.right <= card.right
      );
    }),
  ).toBe(true);
});

test('sidebar expand state, parent keyboard navigation, and mixed stream ordering use actual stash IDs', async ({
  page,
}) => {
  await page.goto('/?fixture');
  await create(page, 'Parent');
  await create(page, 'Child');
  await capture(page).fill('child note');
  await capture(page).press('Enter');
  await capture(page).press('Escape');
  await page.keyboard.press('ArrowLeft');
  await expect(page.locator('.app-header h1')).toHaveText(
    /Home\s*\/\s*Parent\s*$/,
  );
  await page.getByRole('button', { name: 'Home', exact: true }).first().click();
  const toggle = page.getByRole('button', { name: 'Collapse stash Parent' });
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await toggle.click();
  await expect(
    page.getByRole('button', { name: 'Open stash Child', exact: true }),
  ).toHaveCount(0);
  await page.getByRole('button', { name: 'Expand stash Parent' }).click();
  await expect(
    page.getByRole('button', { name: 'Open stash Child', exact: true }),
  ).toBeVisible();
  await page.getByRole('article', { name: 'Stash Parent' }).click();
  await page.keyboard.press('ArrowRight');
  await expect(
    page.getByRole('article', { name: 'Stash Child' }),
  ).toBeVisible();
  await capture(page).fill('parent note');
  await capture(page).press('Enter');
  const entries = page
    .getByRole('region', { name: 'Note stream' })
    .getByRole('article');
  await expect(entries).toHaveCount(2);
  await expect(entries.first()).toHaveAttribute('aria-label', 'Stash Child');
  await expect(entries.last()).toHaveAttribute('aria-label', 'Saved note');
});

test('successful restore resets capture undo even when restored source equals the previous root draft', async ({
  page,
}) => {
  await page.goto('/?fixture');
  await capture(page).focus();
  await page.keyboard.insertText('same restored source');
  await page.evaluate(() => {
    (window as any).__test.repo.restoreText = JSON.stringify({
      format: 'stashpad-alpha',
      version: 2,
      exportedAt: '2026-11-11T00:00:00.000Z',
      workspace: {
        stashes: [],
        notes: [],
        drafts: [
          {
            key: 'compose',
            markdown: 'same restored source',
            revision: 5,
            updatedAt: 0,
          },
        ],
        undoDeleteId: null,
      },
    });
  });
  await page
    .getByRole('button', { name: 'Restore backup', exact: true })
    .click();
  await page
    .getByRole('button', { name: 'Replace workspace', exact: true })
    .click();
  await expect(capture(page)).toBeFocused();
  await page.keyboard.press('Meta+z');
  await expect(capture(page)).toHaveText('same restored source');
});

test('constrained sidebar keeps actual nested navigation visible and stash creation reachable at 150% text', async ({
  page,
}) => {
  await page.setViewportSize({ width: 800, height: 600 });
  await page.goto('/?fixture');
  await page.addStyleTag({ content: ':root {font-size:24px !important}' });
  await create(page, 'Parent');
  await create(page, 'Child');
  const navigation = page.getByRole('navigation', { name: 'Stashes' });
  expect(
    await navigation.evaluate((el) => el.getBoundingClientRect().height),
  ).toBeGreaterThan(100);
  const child = navigation.getByRole('button', {
    name: 'Open stash Child',
    exact: true,
  });
  await child.scrollIntoViewIfNeeded();
  expect(
    await child.evaluate((el) => {
      const button = el.getBoundingClientRect(),
        nav = el.closest('nav')!.getBoundingClientRect();
      return button.top >= nav.top && button.bottom <= nav.bottom;
    }),
  ).toBe(true);
  const newStash = page.getByRole('button', {
    name: 'New stash Command N',
    exact: true,
  });
  await newStash.scrollIntoViewIfNeeded();
  await newStash.click();
  await expect(page.getByRole('dialog', { name: 'New stash' })).toBeVisible();
  await page.keyboard.press('Escape');
});
