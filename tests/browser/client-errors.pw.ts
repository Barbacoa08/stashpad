import { test, expect, type Page } from '@playwright/test';
import { MemoryRepository } from '../fixtures/memory';

async function nativeMock(
  page: Page,
  fault: 'none' | 'save' | 'render',
  deniedStorage = false,
) {
  const repo = new MemoryRepository();
  if (fault === 'save') repo.fail = 'save';
  let saves = 0;
  await page.exposeFunction(
    '__syntheticIPC',
    async (command: string, args: any) => {
      if (command === 'workspace_load') return repo.loadWorkspace();
      if (command === 'draft_checkpoint')
        return repo.checkpointDraft(args.key, args.markdown, args.revision);
      if (command === 'item_capture') {
        saves++;
        return repo.captureItem(args.request);
      }
      if (command === 'item_save_source') {
        saves++;
        return repo.saveItemSource(args.id, args.markdown, args.draft);
      }
      throw new Error('Unexpected synthetic command');
    },
  );
  await page.addInitScript(
    ({ fault, deniedStorage }) => {
      if (deniedStorage)
        Object.defineProperty(window, 'localStorage', {
          get() {
            throw new Error('PRIVATE_STORAGE_ERROR');
          },
        });
      (window as any).__TAURI_INTERNALS__ = {
        invoke: async (command: string, args: unknown) => {
          const result = await (window as any).__syntheticIPC(command, args);
          if (command === 'item_capture' && fault === 'render') {
            Date.prototype.toLocaleString = () => {
              throw new TypeError('PRIVATE_SYNTHETIC_NOTE_CONTENT');
            };
          }
          return result;
        },
      };
    },
    { fault, deniedStorage },
  );
  return { repo, saveCalls: () => saves };
}
const capture = (page: Page) =>
  page.getByRole('textbox', { name: 'Capture Markdown' });
async function typeCapture(page: Page, source: string) {
  await page.getByRole('region', { name: 'Note stream' }).focus();
  await page.keyboard.press('Space');
  await expect(capture(page)).toBeFocused();
  await page.keyboard.type(source);
  await page.keyboard.press('Enter');
}

test('ordinary shortcut submission retains the workspace and a usable second capture', async ({
  page,
}) => {
  const { repo } = await nativeMock(page, 'none');
  await page.goto('/');
  await expect(capture(page)).toBeVisible();
  await typeCapture(page, 'First synthetic plain capture');
  await expect(capture(page)).toHaveText('');
  await expect(capture(page)).toBeFocused();
  await typeCapture(page, 'Second synthetic plain capture');
  await expect(page.getByRole('article', { name: 'Saved note' })).toHaveCount(
    2,
  );
  await expect(capture(page)).toBeFocused();
  expect(
    repo.snapshot.items
      .filter((x: any) => x.kind === 'note')
      .map((note) => note.markdown),
  ).toEqual([
    'First synthetic plain capture',
    'Second synthetic plain capture',
  ]);
  await expect(page.getByRole('button', { name: 'Reload view' })).toHaveCount(
    0,
  );
});

test('ordinary repository save rejection keeps input in the workspace without fatal fallback or retry', async ({
  page,
}) => {
  const { repo, saveCalls } = await nativeMock(page, 'save');
  await page.goto('/');
  await expect(capture(page)).toBeVisible();
  await typeCapture(page, 'Retained synthetic capture');
  await expect(capture(page)).toHaveText('Retained synthetic capture');
  await expect(page.getByRole('button', { name: 'Reload view' })).toHaveCount(
    0,
  );
  expect(
    repo.snapshot.items.filter((x: any) => x.kind === 'note'),
  ).toHaveLength(0);
  expect(saveCalls()).toBe(1);
});

for (const deniedStorage of [false, true])
  test(`render fault shows safe explicit fallback without resubmission; storage denied=${deniedStorage}`, async ({
    page,
  }) => {
    const { repo, saveCalls } = await nativeMock(page, 'render', deniedStorage);
    await page.goto('/');
    await expect(capture(page)).toBeVisible();
    await typeCapture(page, 'Saved synthetic capture');
    const reload = page.getByRole('button', {
      name: 'Reload view',
      exact: true,
    });
    await expect(reload).toBeVisible();
    await expect(
      page.getByRole('heading', {
        name: 'The notes view encountered an error',
      }),
    ).toBeVisible();
    await expect(
      page.getByText(/Submitted notes may already be saved/),
    ).toBeVisible();
    const diagnostic = page.getByRole('textbox', {
      name: 'Diagnostic details',
    });
    await expect(diagnostic).toHaveValue(/SP-/);
    await expect(diagnostic).toHaveValue(/TypeError/);
    const safeDetails = await diagnostic.inputValue();
    expect(safeDetails).not.toContain('PRIVATE_');
    expect(JSON.parse(safeDetails).locations.length).toBeGreaterThan(0);
    expect(await page.locator('body').innerText()).not.toContain('PRIVATE_');
    expect(
      repo.snapshot.items.filter((x: any) => x.kind === 'note'),
    ).toHaveLength(1);
    expect(saveCalls()).toBe(1);
    await page.waitForTimeout(350);
    expect(saveCalls()).toBe(1);
    await reload.click();
    await expect(capture(page)).toBeVisible();
    await expect(page.getByRole('article', { name: 'Saved note' })).toHaveCount(
      1,
    );
    expect(
      repo.snapshot.items.filter((x: any) => x.kind === 'note')[0].markdown,
    ).toBe('Saved synthetic capture');
    expect(saveCalls()).toBe(1);
  });
