import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    exclude: [
      ...configDefaults.exclude,
      "apps/desktopChamber/**",
      "packages/runtime-pi/test/mcp-auth.test.ts",
      "packages/runtime-pi/test/package-service.test.ts",
    ],
  },
});
