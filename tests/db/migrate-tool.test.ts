import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, appendFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/server/db/client";
import { applyMigrations } from "../../hosting/migrate";

/**
 * The hosting server has no Prisma command-line tool, so database updates are
 * applied there by hosting/migrate.ts. These tests run it against a scratch
 * database and check that Prisma itself agrees with the result.
 */
const SCRATCH = "kuchpos_migratetool_test";
const scratchUrl = (() => {
  const url = new URL(process.env.DATABASE_URL ?? "");
  url.pathname = `/${SCRATCH}`;
  return url.toString();
})();
const MIGRATIONS = join(process.cwd(), "prisma", "migrations");

async function scratchQuery<T>(sql: string): Promise<T[]> {
  return getDb().$queryRawUnsafe<T[]>(sql);
}

beforeEach(async () => {
  await getDb().$executeRawUnsafe(`DROP DATABASE IF EXISTS \`${SCRATCH}\``);
  await getDb().$executeRawUnsafe(
    `CREATE DATABASE \`${SCRATCH}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
  );
});

afterAll(async () => {
  await getDb().$executeRawUnsafe(`DROP DATABASE IF EXISTS \`${SCRATCH}\``);
});

describe("database update tool for the hosting server", () => {
  it("applies every migration to an empty database, including checks and triggers", async () => {
    const result = await applyMigrations({ databaseUrl: scratchUrl, migrationsDir: MIGRATIONS });
    const expected = readdirSync(MIGRATIONS, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    expect(result.applied).toEqual(expected);

    const tables = await scratchQuery<{ name: string }>(
      `SELECT TABLE_NAME AS name FROM information_schema.TABLES WHERE TABLE_SCHEMA = '${SCRATCH}'`,
    );
    expect(tables.map((table) => table.name)).toEqual(
      expect.arrayContaining([
        "business", "user", "session", "account", "activity_log", "rateLimit",
        "location", "terminal", "product", "product_unit", "price_change", "tax_rate_change",
      ]),
    );

    const triggers = await scratchQuery<{ name: string }>(
      `SELECT TRIGGER_NAME AS name FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA = '${SCRATCH}'`,
    );
    expect(triggers.map((trigger) => trigger.name).sort()).toEqual([
      "activity_log_no_delete",
      "activity_log_no_update",
      "price_change_no_delete",
      "price_change_no_update",
      "tax_rate_change_no_delete",
      "tax_rate_change_no_update",
    ]);

    const checks = await scratchQuery<{ name: string }>(
      `SELECT CONSTRAINT_NAME AS name FROM information_schema.CHECK_CONSTRAINTS WHERE CONSTRAINT_SCHEMA = '${SCRATCH}'`,
    );
    expect(checks.map((check) => check.name)).toEqual(
      expect.arrayContaining([
        "user_owner_has_no_business_check",
        "user_username_lowercase_check",
        "business_idle_sign_out_minutes_check",
        "business_tax_rate_percent_check",
        "terminal_code_format_check",
        "product_unit_factor_check",
        "product_unit_price_check",
      ]),
    );
  });

  it("does nothing the second time", async () => {
    const first = await applyMigrations({ databaseUrl: scratchUrl, migrationsDir: MIGRATIONS });
    const second = await applyMigrations({ databaseUrl: scratchUrl, migrationsDir: MIGRATIONS });
    expect(second.applied).toEqual([]);
    expect(second.alreadyApplied).toEqual(first.applied);
  });

  it("leaves the database in a state Prisma itself accepts as up to date", async () => {
    await applyMigrations({ databaseUrl: scratchUrl, migrationsDir: MIGRATIONS });
    const output = execFileSync("npx", ["prisma", "migrate", "status"], {
      env: { ...process.env, DATABASE_URL: scratchUrl },
      encoding: "utf8",
    });
    expect(output).toContain("Database schema is up to date");
  });

  it("refuses to continue if an applied migration file was edited afterwards", async () => {
    await applyMigrations({ databaseUrl: scratchUrl, migrationsDir: MIGRATIONS });

    const copy = mkdtempSync(join(tmpdir(), "kuchpos-migrations-"));
    cpSync(MIGRATIONS, copy, { recursive: true });
    const first = readdirSync(copy, { withFileTypes: true }).filter((entry) => entry.isDirectory())[0].name;
    appendFileSync(join(copy, first, "migration.sql"), "\n-- edited after the fact\n");

    await expect(applyMigrations({ databaseUrl: scratchUrl, migrationsDir: copy })).rejects.toThrow(
      /was changed after it had been applied/,
    );
  });

  it("stops and reports when a migration fails, and refuses to carry on afterwards", async () => {
    const copy = mkdtempSync(join(tmpdir(), "kuchpos-migrations-"));
    cpSync(MIGRATIONS, copy, { recursive: true });
    const broken = join(copy, "29990101000000_broken");
    cpSync(join(copy, readdirSync(copy)[0]), broken, { recursive: true });
    appendFileSync(join(broken, "migration.sql"), "\nTHIS IS NOT SQL;\n");

    await expect(applyMigrations({ databaseUrl: scratchUrl, migrationsDir: copy })).rejects.toThrow(/failed and was stopped/);
    await expect(applyMigrations({ databaseUrl: scratchUrl, migrationsDir: copy })).rejects.toThrow(/did not finish/);
  });
});
