import { defineConfig } from '@playwright/test';
const port = process.env.SCRATCHTREE_TEST_PORT ?? '4611';
if (!/^\d+$/.test(port))
  throw new Error('SCRATCHTREE_TEST_PORT must be numeric');
const baseURL = `http://127.0.0.1:${port}`;
export default defineConfig({
  testDir: 'tests/browser',
  timeout: 15000,
  testMatch: '**/*.pw.ts',
  workers: 1,
  // Keep existing dark-appearance regressions deterministic; appearance tests
  // explicitly exercise both themes and live system changes.
  use: { baseURL, headless: true, colorScheme: 'dark' },
  webServer: {
    command: `pnpm exec vite --host 127.0.0.1 --port ${port} --strictPort`,
    url: baseURL,
    reuseExistingServer: false,
  },
  reporter: 'list',
});
