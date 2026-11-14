import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
const fixture = ts.transpileModule(
  readFileSync(
    new URL('../fixtures/dexie-convergence.ts', import.meta.url),
    'utf8',
  ),
  {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ESNext,
    },
  },
).outputText;
for (const scenario of [
  'refresh',
  'receipts',
  'purge',
  'transfer',
  'engine',
  'overflow',
  'sequence',
  'convergence',
  'engine-confirmation',
  'latest-intent',
  'overflow-input',
  'device-tables',
  'engine-bounds',
  'fix1-latest',
  'fix1-baseline',
  'fix1-neutral',
  'fix2-mixed-source',
  'fix2-mixed-unrelated',
])
  test(`confirmation real IndexedDB: ${scenario}`, async ({ page }) => {
    await page.goto('/?fixture');
    await expect(async () => {
      await page.evaluate(async () => {
        const path = '/src/lib/sync/engine.ts';
        await import(/* @vite-ignore */ path);
      });
    }).toPass();
    const result = await page.evaluate(
      async ({ fixture, scenario }) => {
        const code = fixture.replaceAll(
          '../../src/',
          `${location.origin}/src/`,
        );
        const blob = new Blob([code], { type: 'text/javascript' });
        const url = URL.createObjectURL(blob);
        try {
          const m = await import(/* @vite-ignore */ url);
          return await m.run(scenario);
        } finally {
          URL.revokeObjectURL(url);
        }
      },
      { fixture, scenario },
    );
    expect(result).toBe('ok');
  });
const config = process.env.SCRATCHTREE_DEXIE_CONFIG
  ? JSON.parse(readFileSync(process.env.SCRATCHTREE_DEXIE_CONFIG, 'utf8'))
  : null;
test('managed disposable two-client confirmation and collection contract', async ({
  page,
  browserName,
}) => {
  test.skip(
    !config || browserName !== 'chromium',
    'Requires explicit disposable hosted configuration',
  );
  test.setTimeout(180000);
  page.on('console', (message) => {
    if (message.text().startsWith('task3-schema:')) console.log(message.text());
  });
  const statuses: { path: string; status: number }[] = [];
  const bodies: Promise<void>[] = [];
  let rejections = 0;
  page.on('response', (r) => {
    if (r.url() === config.databaseUrl + '/sync' && r.status() === 200)
      bodies.push(
        (async () => {
          const body = await r.json().catch(() => null);
          if (body?.rejections?.length) {
            rejections += body.rejections.length;
            console.log(
              JSON.stringify({ http200Rejections: body.rejections.length }),
            );
          }
        })(),
      );
    if (r.url().includes('/my/') || r.status() === 422) {
      const status = { path: new URL(r.url()).pathname, status: r.status() };
      statuses.push(status);
      console.log(JSON.stringify(status));
      if (r.status() === 422)
        bodies.push(
          (async () => {
            const error = (await r.text().catch(() => 'unavailable'))
              .replace(/[A-Za-z0-9_@.-]+@[A-Za-z0-9.-]+/g, '[email]')
              .replace(/[A-Za-z0-9_-]{40,}/g, '[redacted]')
              .slice(0, 1000);
            console.log(JSON.stringify({ error422: error }));
          })(),
        );
    }
  });
  await page.goto('/?fixture');
  await expect(async () => {
    await page.evaluate(async () => {
      const path = '/src/lib/sync/engine.ts';
      await import(/* @vite-ignore */ path);
    });
  }).toPass();
  const result = await page
    .evaluate(
      async ({ fixture, config }) => {
        const code = fixture.replaceAll(
          '../../src/',
          `${location.origin}/src/`,
        );
        const url = URL.createObjectURL(
          new Blob([code], { type: 'text/javascript' }),
        );
        try {
          return await (await import(/* @vite-ignore */ url)).runHosted(config);
        } finally {
          URL.revokeObjectURL(url);
        }
      },
      { fixture, config },
    )
    .catch(async (error) => {
      await Promise.allSettled(bodies);
      throw error;
    });
  await Promise.allSettled(bodies);
  console.log(JSON.stringify({ rest: statuses }));
  console.log(JSON.stringify({ hosted: result }));
  expect(rejections).toBeGreaterThan(0);
  expect(result).toMatchObject({
    collection: true,
    twoClients: true,
    largeSource: true,
  });
});
