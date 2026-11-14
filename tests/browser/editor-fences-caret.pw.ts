import { test, expect, type Locator, type Page } from '@playwright/test';

const capture = (page: Page) =>
  page.getByRole('textbox', { name: 'New note Markdown' });
const source = (page: Page, inline = false) =>
  page.evaluate(
    (inline) =>
      inline
        ? (window as any).__test.controller.state.source
        : (window as any).__test.controller.sourceFor('compose'),
    inline,
  );

async function caret(editor: Locator) {
  return editor.evaluate(async (node) => {
    const path = '/node_modules/.vite/deps/@codemirror_view.js';
    const { EditorView } = await import(path);
    const view = EditorView.findFromDOM(node);
    await new Promise((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(resolve)),
    );
    const cursor = view.dom.querySelector('.cm-cursor')!;
    const box = cursor.getBoundingClientRect();
    const clip = view.scrollDOM.getBoundingClientRect();
    return {
      position: view.state.selection.main.head,
      line: view.state.doc.lineAt(view.state.selection.main.head).number,
      left: box.left,
      right: box.right,
      clipLeft: clip.left,
      clipRight: clip.right,
      height: box.height,
      top: box.top,
      bottom: box.bottom,
      clipTop: clip.top,
      clipBottom: clip.bottom,
      blink: getComputedStyle(cursor.parentElement!).animationName,
      margin: getComputedStyle(cursor).marginLeft,
    };
  });
}

test.beforeEach(async ({ page }) => {
  await page.goto('/?fixture');
  await expect(capture(page)).toBeVisible();
});

for (const inline of [false, true]) {
  test(`typed opening fence pairs immediately with atomic Undo in ${inline ? 'inline' : 'capture'}`, async ({
    page,
  }) => {
    let editor = capture(page);
    if (inline) {
      await editor.fill('seed');
      await page
        .getByRole('button', { name: 'Save note', exact: true })
        .click();
      await page.getByRole('article', { name: 'Saved note' }).dblclick();
      editor = page.getByRole('textbox', { name: 'Edit Markdown' });
      await editor.fill('');
    }
    await editor.focus();
    await page.keyboard.type('``');
    // Separate the first two inputs so Undo proves the third input and closer
    // belong to the same history event, rather than merely adjacent typing.
    await editor.press('ArrowLeft');
    await editor.press('ArrowRight');
    await page.keyboard.type('`');
    await expect.poll(() => source(page, inline)).toBe('```\n```');
    expect((await caret(editor)).position).toBe(3);
    await editor.press('Meta+z');
    await expect.poll(() => source(page, inline)).toBe('``');
    await editor.press('Meta+Shift+z');
    await expect.poll(() => source(page, inline)).toBe('```\n```');
    // CM's normal Redo caret is after its full insertion. Return to the opener
    // explicitly, then verify info typing and the existing code Enter policy.
    await editor.press('Meta+Home');
    await editor.press('End');
    await page.keyboard.type('js');
    await editor.press('Enter');
    await expect.poll(() => source(page, inline)).toBe('```js\n\n```');
    expect((await caret(editor)).position).toBe(6);
    for (const key of ['Shift+Enter', 'Meta+Enter']) await editor.press(key);
    await expect.poll(() => source(page, inline)).toBe('```js\n\n\n\n```');
  });
}

test('single typed triple input pairs, while paste and direct longer input stay literal', async ({
  page,
}) => {
  const editor = capture(page);
  await editor.focus();
  await page.keyboard.insertText('```');
  await expect.poll(() => source(page)).toBe('```\n```');
  await editor.fill('');
  await page.keyboard.insertText('````');
  await expect.poll(() => source(page)).toBe('````');
  await editor.fill('');
  await editor.evaluate((node) => {
    const data = new DataTransfer();
    data.setData('text/plain', '```');
    node.dispatchEvent(
      new ClipboardEvent('paste', {
        bubbles: true,
        cancelable: true,
        clipboardData: data,
      }),
    );
  });
  await expect.poll(() => source(page)).toBe('```');
});

for (const inline of [false, true]) {
  for (const [label, original, expected] of [
    ['LF', '`open\n``\nend`', '`open\n```\nend`'],
    ['CRLF', '`open\r\n``\r\nend`', '`open\r\n```\r\nend`'],
    ['mixed', '`open\r\n``\nend`\rlast', '`open\r\n```\nend`\rlast'],
  ])
    test(`${inline ? 'inline' : 'capture'} initial multiline inline-code keeps ${label} source literal through Undo`, async ({
      page,
    }) => {
      await page.evaluate(
        (text) =>
          (window as any).__test.controller.editContext('compose', text),
        original,
      );
      let editor = capture(page);
      await expect.poll(() => source(page)).toBe(original);
      if (inline) {
        await page
          .getByRole('button', { name: 'Save note', exact: true })
          .click();
        await page.getByRole('article', { name: 'Saved note' }).dblclick();
        editor = page.getByRole('textbox', { name: 'Edit Markdown' });
      }
      await editor.focus();
      await editor.press('Meta+Home');
      await editor.press('ArrowDown');
      await editor.press('End');
      await page.keyboard.type('`');
      await expect.poll(() => source(page, inline)).toBe(expected);
      expect((await caret(editor)).position).toBe(9);
      await editor.press('Meta+z');
      await expect.poll(() => source(page, inline)).toBe(original);
      await editor.press('Meta+Shift+z');
      await expect.poll(() => source(page, inline)).toBe(expected);
    });

  for (const [label, original, expected] of [
    ['LF', 'before\n``\nafter', 'before\n```\n```\nafter'],
    ['CRLF', 'before\r\n``\r\nafter', 'before\r\n```\r\n```\r\nafter'],
    ['mixed', 'before\r\n``\nafter\rlast', 'before\r\n```\r\n```\nafter\rlast'],
  ])
    test(`${inline ? 'inline' : 'capture'} fence preserves ${label} bytes on both sides and Undo`, async ({
      page,
    }) => {
      await page.evaluate(
        (text) =>
          (window as any).__test.controller.editContext('compose', text),
        original,
      );
      let editor = capture(page);
      await expect.poll(() => source(page)).toBe(original);
      if (inline) {
        await page
          .getByRole('button', { name: 'Save note', exact: true })
          .click();
        await page.getByRole('article', { name: 'Saved note' }).dblclick();
        editor = page.getByRole('textbox', { name: 'Edit Markdown' });
      }
      await editor.focus();
      await editor.press('Meta+Home');
      await editor.press('ArrowDown');
      await editor.press('End');
      await page.keyboard.type('`');
      await expect.poll(() => source(page, inline)).toBe(expected);
      expect((await caret(editor)).position).toBe(10);
      await editor.press('Meta+z');
      await expect.poll(() => source(page, inline)).toBe(original);
      await editor.press('Meta+Shift+z');
      await expect.poll(() => source(page, inline)).toBe(expected);
    });

  test(`${inline ? 'inline' : 'capture'} supports indentation and only extends its consecutively generated closer`, async ({
    page,
  }) => {
    let editor = capture(page);
    if (inline) {
      await editor.fill('seed');
      await page
        .getByRole('button', { name: 'Save note', exact: true })
        .click();
      await page.getByRole('article', { name: 'Saved note' }).dblclick();
      editor = page.getByRole('textbox', { name: 'Edit Markdown' });
    }
    for (const spaces of ['', ' ', '  ', '   ']) {
      await editor.fill(spaces + '``');
      await editor.press('End');
      await page.keyboard.type('`');
      await expect
        .poll(() => source(page, inline))
        .toBe(spaces + '```\n' + spaces + '```');
      await page.keyboard.type('``');
      await expect
        .poll(() => source(page, inline))
        .toBe(spaces + '`````\n' + spaces + '`````');
    }
    await editor.fill('``\nexisting\n```');
    await editor.press('Meta+Home');
    await editor.press('End');
    await page.keyboard.type('``');
    await expect.poll(() => source(page, inline)).toBe('````\nexisting\n```');
  });
}

test('inline/list/quote/fenced/selection contexts, IME, and read-only do not pair', async ({
  page,
}) => {
  const editor = capture(page);
  for (const [original, down, expected] of [
    ['inline ``', false, 'inline ```'],
    ['> ``', false, '> ```'],
    ['- ``', false, '- ```'],
    ['    ``', false, '    ```'],
    ['- item\n  ``', true, '- item\n  ```'],
    ['~~~\n``\n~~~', true, '~~~\n```\n~~~'],
    ['```\n``\n```', true, '```\n```\n```'],
  ] as const) {
    await editor.fill(original);
    await editor.press('Meta+Home');
    if (down) await editor.press('ArrowDown');
    await editor.press('End');
    await page.keyboard.type('`');
    await expect.poll(() => source(page)).toBe(expected);
  }
  await editor.fill('``x');
  await editor.press('End');
  await editor.press('Shift+ArrowLeft');
  await page.keyboard.type('`');
  await expect.poll(() => source(page)).toBe('```');
  await editor.fill('');
  await editor.dispatchEvent('compositionstart');
  await page.keyboard.insertText('```');
  await expect.poll(() => source(page)).toBe('```');
  await editor.dispatchEvent('compositionend');
  await editor.fill('``');
  await editor.evaluate(async (node) => {
    const viewPath = '/node_modules/.vite/deps/@codemirror_view.js';
    const statePath = '/node_modules/.vite/deps/@codemirror_state.js';
    const { EditorView } = await import(viewPath);
    const { EditorState, StateEffect, Prec } = await import(statePath);
    const view = EditorView.findFromDOM(node);
    view.dispatch({
      effects: StateEffect.appendConfig.of(
        Prec.highest(EditorState.readOnly.of(true)),
      ),
    });
    if (!view.state.readOnly)
      throw Error('Read-only test setup did not take precedence');
  });
  await page.keyboard.type('`');
  await expect.poll(() => source(page)).toBe('``');
});

for (const inline of [false, true])
  test(`${inline ? 'inline' : 'capture'} wrapped overflow keeps blank-line caret inside clip at 800x600 and 150% text`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 800, height: 600 });
    await page.addStyleTag({
      content: ':root { font-size: 24px !important; }',
    });
    const original =
      '```js\n' +
      Array.from(
        { length: 65 },
        (_, i) => `line ${i} ` + 'wrapped content '.repeat(12),
      ).join('\n') +
      '\n\ntail\n```';
    let editor = capture(page);
    await editor.fill(original);
    if (inline) {
      await page
        .getByRole('button', { name: 'Save note', exact: true })
        .click();
      await page.getByRole('article', { name: 'Saved note' }).dblclick();
      editor = page.getByRole('textbox', { name: 'Edit Markdown' });
    }
    await editor.focus();
    await editor.press('Meta+End');
    await editor.press('ArrowUp');
    await editor.press('Home');
    await editor.press('ArrowUp');
    const measured = await caret(editor);
    expect(measured.line).toBe(67);
    expect(measured.left).toBeGreaterThanOrEqual(measured.clipLeft);
    expect(measured.right).toBeLessThanOrEqual(measured.clipRight);
    expect(measured.top).toBeGreaterThanOrEqual(measured.clipTop);
    expect(measured.bottom).toBeLessThanOrEqual(measured.clipBottom);
    expect(measured.blink).not.toBe('none');
    expect(
      await editor.evaluate((node) => {
        const scroll = node
          .closest('.cm-editor')!
          .querySelector('.cm-scroller')!;
        return scroll.scrollHeight > scroll.clientHeight;
      }),
    ).toBe(true);
    expect(await source(page, inline)).toBe(original);
    await page.keyboard.type('x');
    await editor.press('Meta+z');
    await expect.poll(() => source(page, inline)).toBe(original);
  });

for (const inline of [false, true])
  for (const fenced of [false, true])
    test(`real code-line movement keeps full caret within ${inline ? 'inline' : 'capture'} clip (${fenced ? 'fenced' : 'plain'})`, async ({
      page,
    }) => {
      const original = fenced
        ? '```js\nconst i = 3;\n\nconst i = 4;\n```'
        : 'const i = 3;\n\nconst i = 4;';
      let editor = capture(page);
      await editor.fill(original);
      if (inline) {
        await page
          .getByRole('button', { name: 'Save note', exact: true })
          .click();
        await page.getByRole('article', { name: 'Saved note' }).dblclick();
        editor = page.getByRole('textbox', { name: 'Edit Markdown' });
      }
      await editor.focus();
      await editor.press('Meta+Home');
      if (fenced) await editor.press('ArrowDown');
      await editor.press('End');
      const expectedLines = fenced ? [3, 4, 4, 3, 2, 2] : [2, 3, 3, 2, 1, 1];
      const keys = [
        'ArrowDown',
        'ArrowDown',
        'Meta+ArrowLeft',
        'ArrowUp',
        'ArrowUp',
        'Meta+ArrowRight',
      ];
      for (let i = 0; i < keys.length; i++) {
        await editor.press(keys[i]);
        const measured = await caret(editor);
        expect(measured.line, keys[i]).toBe(expectedLines[i]);
        expect(measured.height).toBeGreaterThan(0);
        expect(
          measured.left,
          `${keys[i]} full left stroke`,
        ).toBeGreaterThanOrEqual(measured.clipLeft);
        expect(measured.right).toBeLessThanOrEqual(measured.clipRight);
        expect(measured.blink).not.toBe('none');
        expect(await source(page, inline)).toBe(original);
      }
      // Movement must neither alter source nor create a spurious Undo event.
      await page.keyboard.type('x');
      await editor.press('Meta+z');
      await expect.poll(() => source(page, inline)).toBe(original);
    });
