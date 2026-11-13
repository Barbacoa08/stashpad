import { test, expect, type Page, type Locator } from '@playwright/test';
const capture = (p: Page) =>
  p.getByRole('textbox', { name: 'Capture Markdown' });
const at = (p: Page) =>
  p.evaluate(() => (window as any).__test.controller.state.location);
async function child(p: Page) {
  await p.keyboard.press('Meta+n');
  await expect(capture(p)).toBeFocused();
  return (await at(p)).itemId as string;
}
async function saveChild(p: Page) {
  await capture(p).fill('inline source');
  await capture(p).press('Enter');
  await expect(p.locator('.note-card')).toHaveCount(1);
}
// Wry dispatches these cancelable, untrusted MouseEvents at elementFromPoint.
async function phase(target: Locator, type: string, button: number) {
  return target.evaluate(
    (el, { type, button }) => {
      const event = new MouseEvent(type, {
        button,
        bubbles: true,
        cancelable: true,
        composed: true,
      });
      el.dispatchEvent(event);
      return { prevented: event.defaultPrevented, trusted: event.isTrusted };
    },
    { type, button },
  );
}
async function side(target: Locator, button: number) {
  const events = await target.evaluate(
    (el, button) =>
      ['mousedown', 'mouseup', 'auxclick'].map((type) => {
        const event = new MouseEvent(type, {
          button,
          bubbles: true,
          cancelable: true,
          composed: true,
        });
        el.dispatchEvent(event);
        return { prevented: event.defaultPrevented, trusted: event.isTrusted };
      }),
    button,
  );
  expect(events).toEqual(Array(3).fill({ prevented: true, trusted: false }));
}
test('Wry side-button release makes exactly one app visit over capture and inline editors', async ({
  page,
}) => {
  await page.goto('/?fixture');
  await expect(capture(page)).toBeVisible();
  const parent = await child(page),
    nested = await child(page);
  // History only opens valid stashes; a saved child keeps nested available.
  await saveChild(page);
  await capture(page).fill('nested **draft**');
  expect(await phase(capture(page), 'mousedown', 3)).toEqual({
    prevented: true,
    trusted: false,
  });
  expect((await at(page)).itemId).toBe(nested);
  expect(await phase(capture(page), 'mouseup', 3)).toEqual({
    prevented: true,
    trusted: false,
  });
  await expect.poll(() => at(page)).toEqual({ scope: 'live', itemId: parent });
  expect(await phase(capture(page), 'auxclick', 3)).toEqual({
    prevented: true,
    trusted: false,
  });
  expect((await at(page)).itemId).toBe(parent);
  await side(capture(page), 4);
  await expect.poll(() => at(page)).toEqual({ scope: 'live', itemId: nested });
  await expect(capture(page)).toHaveText('nested **draft**');
  await page.locator('.note-card').dblclick();
  const editor = page.getByRole('textbox', { name: 'Edit Markdown' });
  await editor.fill('inline **exact**');
  await side(editor, 3);
  await expect.poll(() => at(page)).toEqual({ scope: 'live', itemId: parent });
  await side(capture(page), 4);
  await expect.poll(() => at(page)).toEqual({ scope: 'live', itemId: nested });
  expect(
    await page.evaluate(
      () =>
        (window as any).__test.repo.snapshot.items.find(
          (x: any) => x.kind === 'note',
        ).markdown,
    ),
  ).toBe('inline **exact**');
});
test('side events consume URL fallback at boundaries, blocked state, and before load; ordinary buttons stay native', async ({
  page,
}) => {
  await page.goto('/?fixture&failLoad');
  await expect(
    page.getByRole('button', { name: 'Retry loading workspace' }),
  ).toBeVisible();
  await side(page.locator('main'), 3);
  await side(page.locator('main'), 4);
  await page.goto('/?fixture');
  await expect(capture(page)).toBeVisible();
  await side(capture(page), 3);
  await side(capture(page), 4);
  for (const button of [0, 1, 2])
    for (const type of ['mousedown', 'mouseup', 'auxclick'])
      expect(
        (await phase(page.locator('.app-header'), type, button)).prevented,
      ).toBe(false);
  const parent = await child(page),
    nested = await child(page);
  // History only opens valid stashes; a saved child keeps nested available.
  await saveChild(page);
  await page.evaluate((id) => {
    const t = (window as any).__test,
      setColor = t.repo.setItemColor.bind(t.repo);
    t.repo.setItemColor = async (...args: any[]) => {
      await new Promise<void>((resolve) => {
        t.releaseColor = resolve;
      });
      return setColor(...args);
    };
    void t.controller.setItemColor(id, 'blue');
  }, nested);
  await expect
    .poll(() =>
      page.evaluate(() => (window as any).__test.controller.state.operation),
    )
    .toBe('color');
  await side(capture(page), 3);
  await side(capture(page), 4);
  expect((await at(page)).itemId).toBe(nested);
  await page.evaluate(() => (window as any).__test.releaseColor());
  await expect
    .poll(() =>
      page.evaluate(() => (window as any).__test.controller.state.operation),
    )
    .toBeNull();
  await side(capture(page), 3);
  await expect.poll(() => at(page)).toEqual({ scope: 'live', itemId: parent });
  await side(capture(page), 4);
  await expect.poll(() => at(page)).toEqual({ scope: 'live', itemId: nested });
});
test('failed side Back retains exact draft and captured Retry without reclaiming newer Search focus', async ({
  page,
}) => {
  await page.goto('/?fixture');
  await expect(capture(page)).toBeVisible();
  const parent = await child(page),
    nested = await child(page);
  // History only opens valid stashes; a saved child keeps nested available.
  await saveChild(page);
  await page.evaluate(() => {
    (window as any).__test.repo.fail = 'checkpoint';
  });
  await capture(page).fill('failed exact **draft**');
  await side(capture(page), 3);
  await expect(page.getByRole('alert')).toContainText('failure');
  expect((await at(page)).itemId).toBe(nested);
  await page.evaluate(() => {
    const t = (window as any).__test;
    t.repo.fail = null;
    t.delayCheckpoint();
  });
  await page.getByRole('button', { name: 'Retry action', exact: true }).click();
  await page.getByRole('searchbox').fill('newer');
  await page.evaluate(() => (window as any).__test.releaseCheckpoint());
  await expect.poll(() => at(page)).toEqual({ scope: 'live', itemId: parent });
  await expect(page.getByRole('searchbox')).toBeFocused();
  await expect(page.getByRole('searchbox')).toHaveValue('newer');
  await side(capture(page), 4);
  await expect.poll(() => at(page)).toEqual({ scope: 'live', itemId: nested });
  await expect(capture(page)).toHaveText('failed exact **draft**');
});
test('side Back skips a demoted history entry without promoting it and explicit enter restores its exact draft', async ({
  page,
}) => {
  await page.goto('/?fixture');
  await expect(capture(page)).toBeVisible();
  const [empty, destination] = await page.evaluate(async () => {
    const t = (window as any).__test;
    const empty = crypto.randomUUID(),
      id = crypto.randomUUID();
    await t.repo.createChildStash({
      id: empty,
      parent: { scope: 'live', itemId: null },
    });
    await t.repo.createChildStash({
      id,
      parent: { scope: 'live', itemId: null },
    });
    await t.repo.saveItemSource(id, 'Nonempty destination', {
      key: id,
      revision: 1,
    });
    await t.repo.captureItem({
      id: crypto.randomUUID(),
      location: { scope: 'live', itemId: id },
      markdown: 'saved child',
      draft: { key: `compose:${id}`, revision: 0 },
    });
    await t.controller.start();
    return [empty, id];
  });
  await page.locator(`[data-entry-id="${empty}"]`).click();
  await page.keyboard.press('ArrowRight');
  await capture(page).fill('empty owner exact **draft**');
  await page
    .getByRole('button', {
      name: 'Open stash Nonempty destination',
      exact: true,
    })
    .click();
  await expect
    .poll(() => at(page))
    .toEqual({ scope: 'live', itemId: destination });
  await side(capture(page), 3);
  await expect.poll(() => at(page)).toEqual({ scope: 'live', itemId: null });
  const demoted = page.locator(`[data-entry-id="${empty}"]`);
  await expect(demoted).toHaveAttribute('data-kind', 'note');
  await side(capture(page), 4);
  await expect
    .poll(() => at(page))
    .toEqual({ scope: 'live', itemId: destination });
  await side(capture(page), 3);
  await expect.poll(() => at(page)).toEqual({ scope: 'live', itemId: null });
  await demoted.click();
  await page.keyboard.press('ArrowRight');
  await expect.poll(() => at(page)).toEqual({ scope: 'live', itemId: empty });
  await expect(capture(page)).toHaveText('empty owner exact **draft**');
});
test('detaching the mouse adapter removes its release routing and default interception', async ({
  page,
}) => {
  await page.goto('/?fixture');
  await expect(capture(page)).toBeVisible();
  const result = await page.evaluate(async () => {
    const path = '/src/lib/platform/mouse-history.ts';
    const { attachMouseHistory } = await import(path);
    // An independent DOM window has no mounted workspace or parent listeners.
    const frame = document.createElement('iframe');
    document.body.append(frame);
    const target = frame.contentWindow!,
      visits: number[] = [];
    const detach = attachMouseHistory(target, (direction: number) =>
      visits.push(direction),
    );
    const dispatch = (button: number) => {
      const event = new MouseEvent('mouseup', {
        button,
        bubbles: true,
        cancelable: true,
      });
      target.document.body.dispatchEvent(event);
      return event.defaultPrevented;
    };
    const attached = dispatch(3);
    detach();
    const detached = dispatch(4);
    frame.remove();
    return { attached, detached, visits };
  });
  expect(result).toEqual({ attached: true, detached: false, visits: [-1] });
});
