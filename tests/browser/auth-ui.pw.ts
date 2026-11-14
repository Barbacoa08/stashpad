import { expect, test } from '@playwright/test';

test('sign-in starts with both fields and a disabled code', async ({
  page,
}) => {
  await page.goto('/?fixture&authFixture');
  await page.getByRole('button', { name: 'Sign in / sign up' }).click();
  const dialog = page.getByRole('dialog', { name: 'Sign in / sign up' });
  await expect(dialog.getByLabel('Email')).toBeEnabled();
  await expect(dialog.getByLabel('Code')).toBeDisabled();
  await expect(
    dialog.getByRole('button', { name: 'Send code' }),
  ).toBeDisabled();
});

test('challenge retains input, locks cancellation while verifying, and returns focus', async ({
  page,
}) => {
  await page.goto('/?fixture&authFixture');
  const trigger = page.getByRole('button', { name: 'Sign in / sign up' });
  await trigger.click();
  const dialog = page.getByRole('dialog');
  const email = dialog.getByLabel('Email');
  const code = dialog.getByLabel('Code');
  await email.fill('synthetic@example.test');
  await dialog.getByRole('button', { name: 'Send code' }).click();
  await expect(dialog.getByText('Sending code…')).toBeVisible();
  await expect(email).toHaveValue('synthetic@example.test');
  await page.evaluate(() =>
    (window as any).authUiFixture.setAuth({ phase: 'code' }),
  );
  await expect(code).toBeFocused();
  await expect(email).toBeDisabled();
  await code.fill('123456');
  await page.evaluate(() =>
    (window as any).authUiFixture.setAuth({ error: 'Wrong code' }),
  );
  await expect(dialog.getByRole('alert')).toHaveText('Wrong code');
  await expect(code).toHaveValue('123456');
  await dialog.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(
    dialog.getByText('Finishing sign in. Please wait.'),
  ).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeVisible();
  await page.evaluate(() =>
    (window as any).authUiFixture.setAuth({
      phase: 'syncing',
      authenticated: true,
      canCancel: true,
      error: 'Network unavailable',
    }),
  );
  await expect(
    dialog.getByText('Signed in. Initial sync is pending.'),
  ).toBeVisible();
  await dialog.getByRole('button', { name: 'Close' }).click();
  await expect(page.getByRole('button', { name: 'Sign out' })).toBeFocused();
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(trigger).toBeVisible();
});

test('sync status distinguishes unknown confirmation and exposes recovery', async ({
  page,
}) => {
  await page.goto('/?fixture&authFixture');
  await page.getByRole('button', { name: 'Local only' }).click();
  await expect(page.getByText('No sync confirmed yet.')).toBeVisible();
  await page.evaluate(() =>
    (window as any).authUiFixture.setSync({
      state: 'needs-sync',
      detail: 'Offline',
      recoveries: 1,
      lastConfirmed: 1700000000000,
    }),
  );
  await expect(page.getByText('Offline', { exact: true })).toBeVisible();
  await expect(page.getByText(/Last confirmed:/)).toBeVisible();
  await page.getByRole('button', { name: 'Export recovery' }).click();
  await expect(page.getByText('Recovery export requested.')).toBeVisible();
  await page.getByRole('button', { name: 'Retry sync' }).click();
  await expect(page.getByRole('button', { name: 'Syncing' })).toBeVisible();
});

test('unknown email and cancellation keep the challenge editable', async ({
  page,
}) => {
  await page.goto('/?fixture&authFixture');
  const trigger = page.getByRole('button', { name: 'Sign in / sign up' });
  await trigger.click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Email').fill('unknown@example.test');
  await dialog.getByRole('button', { name: 'Send code' }).click();
  await page.evaluate(() =>
    (window as any).authUiFixture.setAuth({
      phase: 'email',
      error: 'That account does not exist. Sign-up is coming soon.',
    }),
  );
  await expect(dialog.getByRole('alert')).toContainText('does not exist');
  await expect(dialog.getByLabel('Email')).toHaveValue('unknown@example.test');
  await expect(dialog.getByLabel('Code')).toBeDisabled();
  await page.keyboard.press('Escape');
  await expect(trigger).toBeFocused();
});

test('footer order, themes, focus trap, and screenshots', async ({ page }) => {
  await page.goto('/?fixture&authFixture');
  const nav = page.getByRole('complementary', { name: 'Editor navigation' });
  await expect(
    nav.getByRole('button', { name: 'Sign in / sign up' }),
  ).toBeVisible();
  const names = await nav
    .locator('.backup-actions button, .auth-footer button')
    .allTextContents();
  expect(names.map((name) => name.trim())).toEqual([
    'Trash',
    'Export backup',
    'Restore backup',
    'Undo delete',
    'Sign in / sign up',
  ]);
  await expect(nav.locator('.auth-footer')).toHaveCSS(
    'border-top-width',
    '1px',
  );
  await expect(nav.locator('.appearance-setting')).toHaveCSS(
    'border-top-width',
    '1px',
  );
  for (const theme of ['Light', 'Dark', 'System']) {
    await nav.getByRole('radio', { name: theme }).check();
    await page.getByRole('button', { name: 'Sign in / sign up' }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByLabel('Email')).toBeFocused();
    await page.keyboard.press('Shift+Tab');
    await expect(dialog.getByRole('button', { name: 'Close' })).toBeFocused();
    await page.screenshot({
      path: `.projects/2026-11-14-dexie-cloud-implementation/auth-${theme.toLowerCase()}.png`,
    });
    await page.keyboard.press('Escape');
  }
});

test('collapsed details keeps sync recovery accessible', async ({ page }) => {
  await page.goto('/?fixture&authFixture');
  await expect(page.getByRole('button', { name: 'Local only' })).toBeVisible();
  await page.evaluate(() =>
    (window as any).authUiFixture.setSync({
      state: 'needs-sync',
      detail: 'Offline',
      recoveries: 1,
    }),
  );
  await page.getByRole('button', { name: 'Hide Details' }).click();
  await page.getByRole('button', { name: 'Needs sync' }).click();
  await expect(page.getByText('Offline', { exact: true })).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Export recovery' }),
  ).toBeVisible();
});

test('joining requires an explicit choice and explains recovery', async ({
  page,
}) => {
  await page.goto('/?fixture&authFixture');
  await page.getByRole('button', { name: 'Sign in / sign up' }).click();
  await page.evaluate(() =>
    (window as any).authUiFixture.setAuth({
      phase: 'syncing',
      authenticated: true,
      join: { localNotes: 2, cloudNotes: 3 },
    }),
  );
  const dialog = page.getByRole('dialog');
  await expect(
    dialog.getByText('This Mac has 2 notes. Synced notes: 3.'),
  ).toBeVisible();
  await expect(
    dialog.getByText('This Mac’s notes will be kept in recovery.'),
  ).toBeVisible();
  await expect(
    dialog.getByRole('button', { name: 'Use synced notes' }),
  ).toBeVisible();
  await dialog.getByRole('button', { name: 'Use synced notes' }).click();
  await expect(dialog.getByRole('alert')).toHaveText('Synced notes selected.');
});

test('retained email can be resubmitted and restart clears a prior challenge', async ({
  page,
}) => {
  await page.goto('/?fixture&authFixture');
  const trigger = page.getByRole('button', { name: 'Sign in / sign up' });
  await trigger.click();
  let dialog = page.getByRole('dialog');
  await dialog.getByLabel('Email').fill('retained@example.test');
  await dialog.getByRole('button', { name: 'Send code' }).click();
  await page.evaluate(() =>
    (window as any).authUiFixture.setAuth({
      phase: 'email',
      error: 'Try again',
    }),
  );
  await dialog.getByRole('button', { name: 'Close' }).click();
  await trigger.click();
  dialog = page.getByRole('dialog');
  await expect(dialog.getByLabel('Email')).toHaveValue('retained@example.test');
  await expect(dialog.getByRole('button', { name: 'Send code' })).toBeEnabled();
  await dialog.getByRole('button', { name: 'Send code' }).click();
  await page.evaluate(() =>
    (window as any).authUiFixture.setAuth({ phase: 'code' }),
  );
  await dialog.getByLabel('Code').fill('123');
  await page.evaluate(() =>
    (window as any).authUiFixture.setAuth({ error: 'Invalid code' }),
  );
  await expect(dialog.getByLabel('Code')).toHaveValue('123');
  await dialog.getByRole('button', { name: 'Start over' }).click();
  await expect(dialog.getByLabel('Email')).toBeEnabled();
  await dialog.getByRole('button', { name: 'Send code' }).click();
  await page.evaluate(() =>
    (window as any).authUiFixture.setAuth({ phase: 'code' }),
  );
  await expect(dialog.getByLabel('Code')).toHaveValue('');
});

test('backdrop respects bounds and verification has a focus target', async ({
  page,
}) => {
  await page.goto('/?fixture&authFixture');
  const trigger = page.getByRole('button', { name: 'Sign in / sign up' });
  await trigger.click();
  const dialog = page.getByRole('dialog');
  const box = (await dialog.boundingBox())!;
  await page.mouse.click(box.x + 3, box.y + 3);
  await expect(dialog).toBeVisible();
  await page.evaluate(() =>
    (window as any).authUiFixture.setAuth({
      phase: 'verifying',
      canCancel: false,
    }),
  );
  await expect(
    dialog.getByText('Finishing sign in. Please wait.'),
  ).toBeFocused();
  await page.mouse.click(1, 1);
  await expect(dialog).toBeVisible();
  await page.evaluate(() =>
    (window as any).authUiFixture.setAuth({ phase: 'email', canCancel: true }),
  );
  await page.mouse.click(1, 1);
  await expect(dialog).toBeHidden();
});

test('unavailable explanation and compact needs-sync are discoverable', async ({
  page,
}) => {
  await page.goto('/?fixture&authFixture');
  await page.getByRole('button', { name: 'Local only' }).waitFor();
  await page.evaluate(() =>
    (window as any).authUiFixture.setAuth({ configured: false }),
  );
  await expect(page.getByText('Sign in is not configured.')).toBeVisible();
  await expect(page.locator('#auth-unavailable')).not.toHaveClass('sr-only');
  await page.evaluate(() =>
    (window as any).authUiFixture.setSync({
      state: 'needs-sync',
      detail: null,
      recoveries: 0,
    }),
  );
  await page.getByRole('button', { name: 'Hide Details' }).click();
  await expect(page.getByRole('button', { name: 'Needs sync' })).toBeVisible();
});

test('restore preview blocks auth until its decision settles', async ({
  page,
}) => {
  await page.goto('/?fixture&authFixture');
  const trigger = page.getByRole('button', { name: 'Sign in / sign up' });
  await trigger.waitFor();
  await page.getByRole('button', { name: 'Export backup' }).click();
  await page.evaluate(() => {
    const t = (window as any).__test;
    t.repo.restoreText = t.repo.exported;
  });
  await page.getByRole('button', { name: 'Restore backup' }).click();
  await expect(
    page.getByRole('button', { name: 'Cancel restore' }),
  ).toBeVisible();
  await expect(trigger).toBeDisabled();
  await trigger.dispatchEvent('click');
  await expect(
    page.getByRole('dialog', { name: 'Sign in / sign up' }),
  ).toHaveCount(0);
  await page.getByRole('button', { name: 'Cancel restore' }).click();
  await expect(trigger).toBeEnabled();
});

test('overflow recovery is reachable with no ordinary recovery records and exact correction', async ({
  page,
}) => {
  await page.goto('/?fixture&authFixture');
  await page.getByRole('button', { name: 'Local only' }).waitFor();
  await page.evaluate(() =>
    (window as any).authUiFixture.setSync({
      state: 'needs-sync',
      detail: 'Merged library needs recovery.',
      recoveries: 0,
      overflow: { items: 1 },
    }),
  );
  await page.getByRole('button', { name: 'Hide Details' }).click();
  await page.getByRole('button', { name: 'Needs sync' }).click();
  await expect(
    page.getByRole('button', { name: 'Export recovery' }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Review raw notes' }).click();
  const dialog = page.getByRole('dialog', { name: 'Recover merged notes' });
  await expect(dialog).toBeVisible();
  await expect(dialog).not.toContainText('00000000-0000');
  await expect(
    dialog.getByRole('button', { name: 'Permanently remove selected' }),
  ).toBeDisabled();
  await dialog
    .getByRole('checkbox', { name: 'Synthetic oversized note' })
    .check();
  await dialog
    .getByRole('button', { name: 'Permanently remove selected' })
    .click();
  await expect(dialog.getByText('No raw notes remain.')).toBeVisible();
  await dialog.getByRole('button', { name: 'Close' }).click();
  await expect(page.getByRole('button', { name: 'Needs sync' })).toBeFocused();
});

test('recovery file errors are caught and remain actionable', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/?fixture&authFixture');
  await page.getByRole('button', { name: 'Local only' }).waitFor();
  await page.evaluate(() => {
    const f = (window as any).authUiFixture;
    f.setSync({ recoveries: 1 });
    f.failRecovery(true);
  });
  await page.getByRole('button', { name: 'Local only' }).click();
  await page.getByRole('button', { name: 'Export recovery' }).click();
  await expect(page.locator('.sync-status [role="alert"]')).toHaveText(
    'Synthetic export failure',
  );
  await page.evaluate(() => (window as any).authUiFixture.failRecovery(false));
  await page.getByRole('button', { name: 'Export recovery' }).click();
  await expect(page.getByText('Recovery export requested.')).toBeVisible();
  expect(errors).toEqual([]);
});

test('raw recovery selection never carries into a replacement epoch with reused IDs', async ({
  page,
}) => {
  await page.goto('/?fixture&authFixture');
  await page.getByRole('button', { name: 'Local only' }).waitFor();
  await page.evaluate(() => {
    const f = (window as any).authUiFixture;
    f.setSync({ state: 'needs-sync', overflow: { items: 1 } });
    f.replaceDuringPurge();
  });
  await page.getByRole('button', { name: 'Needs sync' }).click();
  await page.getByRole('button', { name: 'Review raw notes' }).click();
  const dialog = page.getByRole('dialog', { name: 'Recover merged notes' });
  await dialog
    .getByRole('checkbox', { name: 'Synthetic oversized note' })
    .check();
  await dialog
    .getByRole('button', { name: 'Permanently remove selected' })
    .click();
  await expect(
    dialog.getByRole('checkbox', { name: 'New epoch note' }),
  ).not.toBeChecked();
  await expect(
    dialog.getByRole('button', { name: 'Permanently remove selected' }),
  ).toBeDisabled();
});

test('recovery dialog traps keyboard commands and fits narrow light and dark views', async ({
  page,
}) => {
  await page.setViewportSize({ width: 800, height: 600 });
  await page.goto('/?fixture&authFixture');
  await page.getByRole('button', { name: 'Sign in / sign up' }).waitFor();
  await page.evaluate(() =>
    (window as any).authUiFixture.setSync({
      state: 'needs-sync',
      overflow: { items: 1 },
    }),
  );
  await page.getByRole('button', { name: 'Needs sync' }).click();
  for (const theme of ['Light', 'Dark']) {
    await page.getByRole('radio', { name: theme, exact: true }).check();
    await page.getByRole('button', { name: 'Review raw notes' }).click();
    const dialog = page.getByRole('dialog', { name: 'Recover merged notes' });
    const checkbox = dialog.getByRole('checkbox');
    await checkbox.focus();
    await checkbox.press('Shift+Tab');
    await expect(
      dialog.getByRole('button', { name: 'Close', exact: true }),
    ).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(checkbox).toBeFocused();
    await page.keyboard.press('Meta+n');
    await expect(page.locator('.note-card')).toHaveCount(0);
    expect(
      await dialog.evaluate((node) => node.scrollWidth <= node.clientWidth),
    ).toBe(true);
    await page.screenshot({
      path: `.projects/2026-11-14-dexie-cloud-implementation/recovery-ui-${theme.toLowerCase()}.png`,
    });
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(
      page.getByRole('button', { name: 'Needs sync' }),
    ).toBeFocused();
  }
});

test('raw recovery blocks capture commands and mouse history until closed', async ({
  page,
}) => {
  await page.goto('/?fixture&authFixture');
  await page.getByRole('textbox', { name: 'New note Markdown' }).waitFor();
  await page.evaluate(async () => {
    const t = (window as any).__test;
    t.seed({
      items: [
        {
          id: '00000000-0000-4000-8000-000000000001',
          markdown: 'Parent',
          kind: 'tree',
        },
        {
          id: '00000000-0000-4000-8000-000000000002',
          markdown: 'Child',
          kind: 'tree',
          parentId: '00000000-0000-4000-8000-000000000001',
        },
      ],
      drafts: [],
      undoDeleteIds: [],
    });
    await t.controller.start();
  });
  await page
    .locator(
      '[data-entry-id="00000000-0000-4000-8000-000000000001"] .note-body',
    )
    .click();
  await page.keyboard.press('ArrowRight');
  await page
    .locator(
      '[data-entry-id="00000000-0000-4000-8000-000000000002"] .note-body',
    )
    .click();
  await page.keyboard.press('ArrowRight');
  await page.evaluate(() => {
    const t = (window as any).__test;
    const original = t.controller.flush.bind(t.controller);
    t.flushCalls = 0;
    t.controller.flush = (...args: unknown[]) => {
      t.flushCalls++;
      return original(...args);
    };
    (window as any).authUiFixture.setSync({
      state: 'needs-sync',
      overflow: { items: 1 },
    });
  });
  await page.getByRole('button', { name: 'Needs sync' }).click();
  await page.getByRole('button', { name: 'Review raw notes' }).click();
  const dialog = page.getByRole('dialog', { name: 'Recover merged notes' });
  await dialog.getByRole('checkbox').focus();
  for (const key of ['Meta+1', 'Meta+/']) await page.keyboard.press(key);
  await page.evaluate(() =>
    window.dispatchEvent(
      new MouseEvent('mouseup', { button: 3, bubbles: true }),
    ),
  );
  expect(
    await page.evaluate(() => (window as any).__test.controller.state.ownerId),
  ).toBe('00000000-0000-4000-8000-000000000002');
  expect(await page.evaluate(() => (window as any).__test.flushCalls)).toBe(0);
  await dialog.getByRole('button', { name: 'Close' }).click();
  await expect(page.getByRole('button', { name: 'Needs sync' })).toBeFocused();
  await page.keyboard.press('Meta+1');
  await expect
    .poll(() =>
      page.evaluate(() => (window as any).__test.controller.state.ownerId),
    )
    .toBe(null);
});

test('raw recovery inspects exact matching-prefix sources before removing the chosen row', async ({
  page,
}) => {
  await page.goto('/?fixture&authFixture');
  await page.getByRole('button', { name: 'Local only' }).waitFor();
  await page.evaluate(() => {
    const f = (window as any).authUiFixture;
    const prefix = '# Same heading\n' + 'x'.repeat(180);
    f.setRows([
      {
        id: '00000000-0000-4000-8000-000000000001',
        markdown: prefix + '\nFirst unique body',
      },
      {
        id: '00000000-0000-4000-8000-000000000002',
        markdown: prefix + '\nSecond unique body',
      },
    ]);
    f.setSync({ state: 'needs-sync', overflow: { items: 2 } });
  });
  await page.getByRole('button', { name: 'Needs sync' }).click();
  await page.getByRole('button', { name: 'Review raw notes' }).click();
  const dialog = page.getByRole('dialog', { name: 'Recover merged notes' });
  await page.setViewportSize({ width: 375, height: 600 });
  const inspect = dialog.getByRole('button', { name: /Inspect raw Markdown/ });
  await inspect.nth(0).focus();
  await page.keyboard.press('Enter');
  await expect(
    dialog.getByRole('textbox', { name: 'Raw Markdown' }),
  ).toHaveValue('# Same heading\n' + 'x'.repeat(180) + '\nFirst unique body');
  await inspect.nth(1).focus();
  await page.keyboard.press('Enter');
  await expect(
    dialog.getByRole('textbox', { name: 'Raw Markdown' }),
  ).toHaveValue('# Same heading\n' + 'x'.repeat(180) + '\nSecond unique body');
  await dialog.getByRole('checkbox').nth(1).check();
  expect(
    await dialog.evaluate((node) => node.scrollWidth <= node.clientWidth),
  ).toBe(true);
  await expect(dialog).not.toContainText('00000000-0000');
  await dialog
    .getByRole('button', { name: 'Permanently remove selected' })
    .click();
  expect(
    await page.evaluate(() => (window as any).authUiFixture.lastPurge()),
  ).toEqual({
    epoch: 'captured-epoch',
    ids: ['00000000-0000-4000-8000-000000000002'],
  });
});
