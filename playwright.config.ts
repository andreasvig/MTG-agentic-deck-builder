import { defineConfig, devices } from "@playwright/test";

const frontendUrl = "http://127.0.0.1:41737";
const reuseExistingServer =
  process.env.PLAYWRIGHT_REUSE_EXISTING_SERVER === "true";

export default defineConfig({
  testDir: "./e2e",
  outputDir: "./test-results",
  fullyParallel: false,
  forbidOnly: true,
  retries: 0,
  reporter: [["list"]],
  expect: {
    timeout: 8_000,
  },
  use: {
    ...devices["Desktop Chrome"],
    baseURL: frontendUrl,
    browserName: "chromium",
    channel: "chrome",
    reducedMotion: "reduce",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  webServer: {
    command: "npm run dev",
    cwd: ".",
    url: frontendUrl,
    reuseExistingServer,
    timeout: 120_000,
    stdout: "pipe",
    stderr: "pipe",
    gracefulShutdown: {
      signal: "SIGTERM",
      timeout: 10_000,
    },
  },
});
