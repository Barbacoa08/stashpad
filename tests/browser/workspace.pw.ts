import { test, expect } from '@playwright/test';
const replace = async (page: import('@playwright/test').Page, text: string) => {
  const e = await edit(page);
  await e.focus();
  await e.press('Meta+a');
  await page.keyboard.insertText(text);
};
const edit = (page: import('@playwright/test').Page) =>
  page
    .getByRole('textbox', { name: 'Edit Markdown' })
    .or(page.getByRole('textbox', { name: 'Capture Markdown' }))
    .first();
test('save search selected-outside-results, clear, new, and compose recovery', async ({
  page,
}) => {
  await page.goto('/?fixture');
  const editor = edit(page);
  await replace(page, 'Alpha **saved**');
  await page.getByRole('button', { name: /^Save note/ }).click();
  await expect(page.getByRole('status')).toHaveText('Saved');
  await page.getByRole('button', { name: 'Edit note', exact: true }).click();
  const search = page.getByRole('searchbox', { name: 'Search saved notes' });
  await search.fill('alpha');
  await replace(page, 'beta draft');
  await page.getByRole('button', { name: 'Save edit', exact: true }).click();
  await expect(page.getByRole('article', { name: 'Saved note' })).toHaveCount(
    0,
  );
  await expect(editor).toHaveText('');
  await search.press('Escape');
  await expect(search).toHaveValue('');
  await expect(page.getByRole('region', { name: 'Note stream' })).toBeFocused();
  await expect(editor).toHaveText('');
  await page.keyboard.press('Space');
  await expect(editor).toHaveText('');
  await expect(editor).toBeFocused();
});
test('delayed save keeps later typing and failed navigation has retry', async ({
  page,
}) => {
  await page.goto('/?fixture');
  const editor = edit(page);
  await replace(page, 'captured');
  await page.evaluate(() => {
    (window as any).__test.delay();
  });
  await page.getByRole('button', { name: /^Save note/ }).click();
  await replace(page, 'newer input');
  await page.evaluate(() => {
    (window as any).__test.release();
  });
  await expect(page.getByRole('status')).toHaveText('Unsaved');
  await expect(editor).toHaveText('newer input');
  await page.evaluate(() => {
    (window as any).__test.repo.fail = 'checkpoint';
  });
  await page.getByRole('button', { name: /^New note/ }).click();
  await expect(page.getByRole('alert')).toContainText('failure');
  await expect(editor).toHaveText('newer input');
  await page.evaluate(() => {
    (window as any).__test.repo.fail = null;
  });
  await page.getByRole('button', { name: 'Retry checkpoint' }).click();
  await expect(page.getByRole('status')).toHaveText('Draft checkpointed');
});
test('delete explicitly confirms discarded draft, cancel preserves it, and undo restores saved source', async ({
  page,
}) => {
  await page.goto('/?fixture');
  const editor = edit(page);
  await replace(page, 'saved source');
  await page.getByRole('button', { name: /^Save note/ }).click();
  await page.getByRole('button', { name: 'Edit note', exact: true }).click();
  await replace(page, 'unfinished edit');
  await page.getByRole('button', { name: 'Delete note', exact: true }).click();
  await page.getByRole('button', { name: 'Keep editing', exact: true }).click();
  await expect(editor).toHaveText('unfinished edit');
  await page.getByRole('button', { name: 'Delete note', exact: true }).click();
  await page
    .getByRole('button', { name: 'Discard draft and delete', exact: true })
    .click();
  await page.getByRole('button', { name: 'Undo delete', exact: true }).click();
  await page.getByRole('button', { name: 'Select note', exact: true }).click();
  await page.getByRole('button', { name: 'Edit note', exact: true }).click();
  await expect(editor).toHaveText('saved source');
});
test('named controls, visible focus, and 800px 150% text reflow', async ({
  page,
}) => {
  await page.setViewportSize({ width: 800, height: 600 });
  await page.goto('/?fixture');
  await page.addStyleTag({ content: 'html {font-size:150%}' });
  await expect(edit(page)).toBeVisible();
  await page.keyboard.press('Meta+f');
  await expect(page.getByRole('searchbox')).toBeFocused();
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(800);
  await expect(
    page.getByRole('button', { name: 'Export backup', exact: true }),
  ).toBeVisible();
});

test('initial read failure offers retry, then save failure retains source and succeeds once', async ({
  page,
}) => {
  await page.goto('/?fixture&failLoad');
  await expect(
    page.getByRole('button', { name: 'Retry loading workspace' }),
  ).toBeVisible();
  await page.evaluate(() => {
    (window as any).__test.repo.fail = null;
  });
  await page.getByRole('button', { name: 'Retry loading workspace' }).click();
  await replace(page, 'retry source');
  await page.evaluate(() => {
    (window as any).__test.repo.fail = 'save';
  });
  await page.getByRole('button', { name: /^Save note/ }).click();
  await expect(page.getByRole('alert')).toContainText('failure');
  await expect(edit(page)).toHaveText('retry source');
  await page.evaluate(() => {
    (window as any).__test.repo.fail = null;
  });
  await page.getByRole('button', { name: 'Retry save', exact: true }).click();
  await expect(page.getByRole('article', { name: 'Saved note' })).toHaveCount(
    1,
  );
});

test('discard confirmation holds the note context until a choice is made', async ({
  page,
}) => {
  await page.goto('/?fixture');
  await replace(page, 'saved');
  await page.getByRole('button', { name: /^Save note/ }).click();
  await page.getByRole('button', { name: 'Edit note', exact: true }).click();
  await replace(page, 'unfinished');
  await page.getByRole('button', { name: 'Delete note', exact: true }).click();
  await expect(page.getByRole('button', { name: /^New note/ })).toBeDisabled();
  await page.keyboard.press('Meta+n');
  await expect(edit(page)).toHaveText('unfinished');
  await page.getByRole('button', { name: 'Keep editing', exact: true }).click();
  await expect(page.getByRole('button', { name: /^New note/ })).toBeEnabled();
});

for (const failFollowup of [false, true])
  test(`pending navigation checkpoint preserves later typing; follow-up failure=${failFollowup}`, async ({
    page,
  }) => {
    await page.goto('/?fixture');
    await replace(page, 'older');
    await page.evaluate((fail) => {
      const t = (window as any).__test;
      t.delayCheckpoint();
      if (fail) t.repo.failCheckpointCall = 2;
    }, failFollowup);
    await page.getByRole('button', { name: /^New note/ }).click();
    await expect
      .poll(() =>
        page.evaluate(() => (window as any).__test.repo.checkpointCalls),
      )
      .toBe(1);
    await replace(page, 'latest');
    await page.evaluate(() => (window as any).__test.releaseCheckpoint());
    await expect
      .poll(() =>
        page.evaluate(() => (window as any).__test.controller.state.source),
      )
      .toBe('latest');
    if (failFollowup) {
      await expect(page.getByRole('alert')).toContainText('failure');
      await page.evaluate(
        () => ((window as any).__test.repo.failCheckpointCall = null),
      );
      await page.getByRole('button', { name: 'Retry checkpoint' }).click();
    }
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (window as any).__test.repo.snapshot.drafts.find(
              (d: any) => d.key === 'compose',
            )?.markdown,
        ),
      )
      .toBe('latest');
  });

test('Keep editing restores editor focus and the existing selection without changing the draft', async ({
  page,
}) => {
  await page.goto('/?fixture');
  const editor = edit(page);
  await replace(page, 'saved source');
  await page.getByRole('button', { name: /^Save note/ }).click();
  await expect(page.getByRole('status')).toHaveText('Saved');
  await page.getByRole('button', { name: 'Edit note', exact: true }).click();
  const key = await page.evaluate(
    () => (window as any).__test.controller.state.activeKey,
  );
  const draft = 'unfinished edit';
  await replace(page, draft);
  await editor.press('Home');
  await editor.press('ArrowRight');
  await editor.press('ArrowRight');
  await editor.press('ArrowRight');
  await editor.press('Shift+ArrowRight');
  await editor.press('Shift+ArrowRight');
  await page.getByRole('button', { name: 'Delete note', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Keep editing', exact: true }),
  ).toBeFocused();
  await page.getByRole('button', { name: 'Keep editing', exact: true }).click();
  await expect(editor).toBeFocused();
  await expect
    .poll(() =>
      page.evaluate(() => (window as any).__test.controller.state.source),
    )
    .toBe(draft);
  await page.keyboard.insertText('X');
  const expected = draft.slice(0, 3) + 'X' + draft.slice(5);
  await expect
    .poll(() =>
      page.evaluate(() => (window as any).__test.controller.state.source),
    )
    .toBe(expected);
  await expect
    .poll(() =>
      page.evaluate(
        (key) =>
          (window as any).__test.repo.snapshot.drafts.find(
            (d: any) => d.key === key,
          )?.markdown,
        key,
      ),
    )
    .toBe(expected);
  expect(
    await page.evaluate(
      () => (window as any).__test.repo.snapshot.notes[0].markdown,
    ),
  ).toBe('saved source');
});
