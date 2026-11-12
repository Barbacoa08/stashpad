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
  await page.evaluate(() =>
    (window as any).__test.controller.setQuery('alpha'),
  );
  await replace(page, 'beta draft');
  await page.getByRole('textbox', { name: 'Edit Markdown' }).press('Enter');
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
  await page.getByRole('region', { name: 'Note stream' }).focus();
  await page.keyboard.press('Space');
  await expect(page.getByRole('alert')).toContainText('failure');
  await expect(editor).toHaveText('newer input');
  await page.evaluate(() => {
    (window as any).__test.repo.fail = null;
  });
  await page.getByRole('button', { name: 'Retry checkpoint' }).click();
  await expect(page.getByRole('status')).toHaveText('Draft checkpointed');
});
test('explicit delete after finish saves latest edit and Undo restores it', async ({
  page,
}) => {
  await page.goto('/?fixture');
  await replace(page, 'saved source');
  await edit(page).press('Enter');
  await page.getByRole('button', { name: 'Edit note', exact: true }).click();
  await replace(page, 'latest edit');
  await edit(page).press('Escape');
  await page.keyboard.press('Meta+Backspace');
  await expect(page.getByRole('article', { name: 'Saved note' })).toHaveCount(
    0,
  );
  await page.getByRole('button', { name: 'Undo delete', exact: true }).click();
  await page.locator('.note-card .note-body').click();
  await page.keyboard.press('e');
  await expect(edit(page)).toHaveText('latest edit');
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

test('failed finish retains note source and prevents navigation until retry', async ({
  page,
}) => {
  await page.goto('/?fixture');
  await replace(page, 'saved');
  await edit(page).press('Enter');
  await page.getByRole('button', { name: 'Edit note', exact: true }).click();
  await page.evaluate(() => ((window as any).__test.repo.fail = 'save'));
  await replace(page, 'retained');
  await edit(page).press('Escape');
  await expect(page.getByRole('alert')).toContainText('failure');
  await expect(page.getByRole('textbox', { name: 'Edit Markdown' })).toHaveText(
    'retained',
  );
  await page.getByRole('region', { name: 'Note stream' }).focus();
  await page.keyboard.press('Space');
  await expect(page.getByRole('textbox', { name: 'Edit Markdown' })).toHaveText(
    'retained',
  );
  await page.evaluate(() => ((window as any).__test.repo.fail = null));
  await page.getByRole('button', { name: 'Retry save', exact: true }).click();
  await expect(
    page.getByRole('textbox', { name: 'Edit Markdown' }),
  ).toHaveCount(0);
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
    await page.getByRole('region', { name: 'Note stream' }).focus();
    await page.keyboard.press('Space');
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

test('background acknowledgment retains editor selection and autosaves replacement selection exactly', async ({
  page,
}) => {
  await page.goto('/?fixture');
  await replace(page, 'saved source');
  await edit(page).press('Enter');
  await page.getByRole('button', { name: 'Edit note', exact: true }).click();
  const editor = page.getByRole('textbox', { name: 'Edit Markdown' });
  const draft = 'unfinished edit';
  await replace(page, draft);
  await editor.press('Home');
  await editor.press('ArrowRight');
  await editor.press('ArrowRight');
  await editor.press('ArrowRight');
  await editor.press('Shift+ArrowRight');
  await editor.press('Shift+ArrowRight');
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as any).__test.repo.snapshot.items.filter(
            (x: any) => x.kind === 'note',
          )[0].markdown,
      ),
    )
    .toBe(draft);
  await expect(editor).toBeFocused();
  await page.keyboard.insertText('X');
  const expected = 'unfXished edit';
  await expect
    .poll(() =>
      page.evaluate(() => (window as any).__test.controller.state.source),
    )
    .toBe(expected);
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as any).__test.repo.snapshot.items.filter(
            (x: any) => x.kind === 'note',
          )[0].markdown,
      ),
    )
    .toBe(expected);
});
