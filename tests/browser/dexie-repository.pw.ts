import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
const fixture = ts.transpileModule(
  readFileSync(
    new URL('../fixtures/dexie-repository.ts', import.meta.url),
    'utf8',
  ),
  {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ESNext,
    },
  },
).outputText;
const cases = [
  'durability',
  'commands',
  'drafts',
  'structure',
  'trash',
  'barriers',
  'backup',
  'capacity',
  'atomicity',
  'epoch-isolation',
  'lost-ack',
  'undo-facts',
  'backup-failures',
  'invalidations',
  'remote-epoch',
  'aggregate-capacity',
  'field-merge-retry',
  'recovery-collision',
  'captured-outcome-clock',
  'purged-latest-input',
  'large-reorder-intent',
] as const;
for (const scenario of cases)
  test(`real IndexedDB repository: ${scenario}`, async ({ page }) => {
    await page.goto('/?fixture');
    await page.waitForFunction(() => '__test' in window);
    await expect(async () => {
      await page.evaluate(async () => {
        const path = '/src/lib/sync/repository.ts';
        await import(/* @vite-ignore */ path);
      });
    }).toPass();
    const result = await page.evaluate(
      async ({ scenario, fixture }) => {
        const code = fixture.replaceAll(
          '../../src/',
          `${location.origin}/src/`,
        );
        const path = URL.createObjectURL(
          new Blob([code], { type: 'text/javascript' }),
        );
        try {
          const { run } = await import(/* @vite-ignore */ path);
          return await run(scenario);
        } finally {
          URL.revokeObjectURL(path);
        }
      },
      { scenario, fixture },
    );
    expect(result).toBe('ok');
  });
