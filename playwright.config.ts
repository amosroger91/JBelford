import { defineConfig, devices } from '@playwright/test';

const PORT = 8799;
export const E2E_TOKEN = 'e2e0123456789abcdef0123456789abcdef0123456789ab';

export default defineConfig({
  testDir: 'test/e2e',
  timeout: 30_000,
  retries: 0,
  workers: 1,
  reporter: [['list']],
  use: { baseURL: `http://127.0.0.1:${PORT}` },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 800 } } },
    { name: 'mobile', use: { ...devices['Pixel 7'] } },
  ],
  webServer: {
    command: `node --disable-warning=ExperimentalWarning --import tsx test/e2e/fixture-server.ts`,
    env: { E2E_PORT: String(PORT), E2E_TOKEN },
    url: `http://127.0.0.1:${PORT}/?token=${E2E_TOKEN}`,
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
