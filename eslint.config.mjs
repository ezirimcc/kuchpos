import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    "src/generated/**",
    "test-results/**",
    "playwright-report/**",
  ]),
  {
    // CLAUDE.md rule 0: application code must reach the database through the
    // business-scoped client, so one business can never see another's records.
    files: ["src/**/*.{ts,tsx}"],
    ignores: ["src/server/db/**", "src/server/auth/**", "src/server/platform/**", "src/app/api/health/**"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "@/server/db/client",
              message:
                "Use businessDb() from @/server/db/scoped. Only the login code and src/server/platform may use the unscoped client.",
            },
          ],
          patterns: [
            {
              group: ["@/generated/prisma/client"],
              importNames: ["PrismaClient"],
              message: "Do not create database clients here. Use businessDb() from @/server/db/scoped.",
            },
          ],
        },
      ],
    },
  },
  {
    // Screens and "use server" actions stay thin: they call operations in src/server, which check permissions.
    files: ["src/app/**/*.{ts,tsx}", "src/components/**/*.{ts,tsx}"],
    ignores: ["src/app/api/health/**"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["@/server/db/*", "@/generated/prisma/*"],
              message: "Screens must not talk to the database. Call an operation in src/server instead.",
            },
          ],
        },
      ],
    },
  },
]);

export default eslintConfig;
