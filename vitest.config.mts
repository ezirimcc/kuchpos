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
    ],
  },
});
