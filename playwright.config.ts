import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: 'tests/browser',
  timeout: 15000,
  testMatch: '**/*.pw.ts',
  workers: 1,
  use: { baseURL: 'http://127.0.0.1:4611', headless: true },
  webServer: {
    command: 'pnpm exec vite --host 127.0.0.1 --port 4611 --strictPort',
    url: 'http://127.0.0.1:4611',
    reuseExistingServer: false,
  },
  reporter: 'list',
});
