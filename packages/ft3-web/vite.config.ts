import "vite-plus/test/config";
import { defineConfig } from "vite-plus";
import { playwright } from "vite-plus/test/browser-playwright";
import * as NodeURL from "node:url";

export default defineConfig({
  resolve: {
    alias: { "~": NodeURL.fileURLToPath(new URL("../../apps/web/src", import.meta.url)) },
  },
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: "ft3-web-unit",
          environment: "node",
          include: ["src/**/*.test.{ts,tsx}"],
          exclude: ["src/**/*.browser.test.{ts,tsx}"],
        },
      },
      {
        extends: true,
        test: {
          name: "ft3-web-browser",
          setupFiles: ["../../apps/web/test/browserSetup.ts"],
          include: ["src/**/*.browser.test.{ts,tsx}"],
          browser: {
            enabled: true,
            headless: true,
            provider: playwright(),
            instances: [{ browser: "chromium" }],
            screenshotFailures: false,
            commands: {
              resetPointer: async ({ page }) => {
                await page.mouse.move(-1, -1);
              },
            },
          },
        },
      },
    ],
  },
});
