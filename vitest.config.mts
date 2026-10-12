import { fileURLToPath } from "node:url";
import { config as loadEnv } from "dotenv";
import { defineConfig } from "vitest/config";

loadEnv({ quiet: true });

const alias = {
  "@": fileURLToPath(new URL("./src", import.meta.url)),
  "server-only": fileURLToPath(new URL("./tests/support/server-only-stub.ts", import.meta.url)),
};

export default defineConfig({
  test: {
    projects: [
      {
        resolve: { alias },
        test: {
          name: "unit",
          environment: "node",
          include: ["src/**/*.test.ts", "tests/unit/**/*.test.ts"],
        },
      },
      {
        // Tests that need a real PostgreSQL database. They use TEST_DATABASE_URL, never the development database.
        resolve: { alias },
        test: {
          name: "db",
          environment: "node",
          include: ["tests/db/**/*.test.ts"],
          globalSetup: ["tests/support/global-setup.ts"],
          fileParallelism: false,
          testTimeout: 20_000,
          hookTimeout: 30_000,
          env: {
            DATABASE_URL: process.env.TEST_DATABASE_URL ?? "",
            BETTER_AUTH_SECRET: "test-only-secret-not-used-anywhere-else",
            BETTER_AUTH_URL: "http://localhost:3000",
          },
        },
      },
      {
        // The speed test on a large sample (M16): slow by nature, run only by `npm run test:speed`.
        resolve: { alias },
        test: {
          name: "speed",
          environment: "node",
          include: ["tests/speed/**/*.test.ts"],
          globalSetup: ["tests/support/global-setup.ts"],
          fileParallelism: false,
          testTimeout: 3_600_000,
          hookTimeout: 3_600_000,
          env: {
            DATABASE_URL: process.env.TEST_DATABASE_URL ?? "",
            BETTER_AUTH_SECRET: "test-only-secret-not-used-anywhere-else",
            BETTER_AUTH_URL: "http://localhost:3000",
          },
        },
      },
    ],
  },
});
