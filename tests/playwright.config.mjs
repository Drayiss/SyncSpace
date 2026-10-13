import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: '.',
  testMatch: '*.spec.mjs',
  timeout: 60_000,
  workers: 1,
  use: {
    baseURL: process.env.WEB_BASE ?? 'http://127.0.0.1:5080',
    browserName: 'chromium',
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  outputDir: '../artifacts/playwright',
  reporter: 'list',
});
