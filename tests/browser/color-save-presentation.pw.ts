import { test, expect, type Page } from '@playwright/test';

async function observePresentation(page: Page) {
  await page.evaluate(() => {
    const t = (window as any).__test;
    const nodes = Array.from(
      document.querySelectorAll(
        '.app-header, .sidebar, .notes-column, .note-card, .markdown-view, .markdown-view *, .cm-editor, .cm-content',
      ),
    );
    const buttons = Array.from(
      document.querySelectorAll<HTMLButtonElement>('button'),
    ).filter((b) => !b.closest('[role="dialog"]'));
    const opacities = () => buttons.map((b) => getComputedStyle(b).opacity);
    t.presentation = { nodes, opacities, before: opacities(), frames: [] };
    const sample = () => {
      t.presentation.frames.push(opacities());
      t.presentation.raf = requestAnimationFrame(sample);
    };
    sample();
    const original = t.repo.setItemColor.bind(t.repo);
    t.repo.setItemColor = async (...args: any[]) => {
      await new Promise<void>((resolve) => {
        t.releaseColor = resolve;
      });
      return original(...args);
    };
  });
}

async function unchangedPresentation(page: Page) {
  const presentation = await page.evaluate(() => {
    const p = (window as any).__test.presentation;
    return {
      identity: p.nodes.every((node: Node) => node.isConnected),
      before: p.before,
      frames: [...p.frames, p.opacities()],
    };
  });
  expect(presentation.identity).toBe(true);
  for (const opacity of presentation.frames)
    expect(opacity).toEqual(presentation.before);
}

for (const undoAvailable of [false, true])
  test(`color apply, failure, and exact Retry keep unrelated presentation stable; Undo available=${undoAvailable}`, async ({
    page,
  }) => {
    await page.goto('/?fixture');
    const capture = page.getByRole('textbox', { name: 'Capture Markdown' });
    for (const source of ['First **saved** note', 'Second saved note']) {
      await capture.fill(source);
      await capture.press('Enter');
    }
    await page.locator('.note-card').last().click();
    if (undoAvailable) {
      await page
        .getByRole('button', { name: 'Delete note', exact: true })
        .click();
      await expect(page.locator('.note-card')).toHaveCount(1);
    }
    await capture.fill('unsent draft');
    await capture.press('Escape');
    await page.locator('.note-card').first().click();
    const id = await page
      .locator('.note-card')
      .first()
      .getAttribute('data-entry-id');
    const undo = page.getByRole('button', { name: 'Undo delete', exact: true });
    await expect(undo).toHaveCSS('opacity', undoAvailable ? '1' : '0.5');
    await expect(
      page.getByRole('button', { name: 'Back', exact: true }),
    ).toHaveCSS('opacity', '0.5');
    await expect(
      page.getByRole('button', { name: 'Forward', exact: true }),
    ).toHaveCSS('opacity', '0.5');
    await page.keyboard.press('l');
    const palette = page.getByRole('dialog', { name: 'Assign color' });
    await expect(palette).toBeVisible();
    await observePresentation(page);
    for (const attempt of ['apply', 'failure', 'retry']) {
      if (attempt === 'failure') {
        await page.evaluate(() => {
          (window as any).__test.repo.fail = 'color';
        });
        await page.getByRole('region', { name: 'Note stream' }).focus();
        await page.keyboard.press('l');
      }
      if (attempt === 'retry') {
        await page.evaluate(() => {
          (window as any).__test.repo.fail = null;
        });
        await page
          .getByRole('button', { name: 'Retry action', exact: true })
          .click();
      } else {
        await palette
          .getByRole('button', {
            name: attempt === 'apply' ? 'Blue' : 'Red',
            exact: true,
          })
          .click();
      }
      await expect
        .poll(() =>
          page.evaluate(
            () => (window as any).__test.controller.state.operation,
          ),
        )
        .toBe('color');
      if (attempt === 'retry') await expect(palette).toHaveCount(0);
      else
        await expect(palette.getByRole('grid')).toHaveAttribute(
          'aria-busy',
          'true',
        );
      await expect(
        page.getByRole('button', { name: 'Root', exact: true }),
      ).toBeDisabled();
      await expect(undo).toBeDisabled();
      await expect(capture).toHaveAttribute('aria-readonly', 'true');
      await page.evaluate(
        () =>
          new Promise<void>((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
          ),
      );
      await unchangedPresentation(page);
      await page.evaluate(() => (window as any).__test.releaseColor());
      if (attempt === 'failure')
        await expect(palette.getByRole('alert')).toContainText('failure');
      else await expect(palette).toHaveCount(0);
      await expect(capture).toHaveAttribute('aria-readonly', 'false');
      await unchangedPresentation(page);
      expect(
        await page.evaluate(
          (id) =>
            (window as any).__test.repo.snapshot.items.find(
              (item: any) => item.id === id,
            ).color,
          id,
        ),
      ).toBe(attempt === 'retry' ? 'red' : 'blue');
    }
    await page.evaluate(() =>
      cancelAnimationFrame((window as any).__test.presentation.raf),
    );
    await expect(capture).toHaveText('unsent draft');
    if (undoAvailable) await expect(undo).toBeEnabled();
    else await expect(undo).toBeDisabled();
  });
