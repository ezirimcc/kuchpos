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
        "category", "supplier", "stock_balance", "stock_movement", "goods_receipt", "goods_receipt_line",
      ]),
    );

    const triggers = await scratchQuery<{ name: string }>(
      `SELECT TRIGGER_NAME AS name FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA = '${SCRATCH}'`,
    );
    // Every add-only table is protected against both changes and deletions.
    const addOnlyTables = [
      "activity_log",
      "price_change",
      "tax_rate_change",
      "stock_movement",
      "goods_receipt_version",
      "goods_receipt_version_line",
      "goods_receipt_change",
      "stock_transfer",
      "stock_transfer_line",
      "stock_count",
      "stock_count_line",
      "stock_adjustment",
      "stock_adjustment_line",
      "stock_adjustment_decision",
      "sale",
      "sale_line",
      "payment",
      "sale_receipt_print",
      "till_session",
      "till_session_close",
      "till_session_recount",
      "sale_cancellation",
      "refund",
      "customer_account_entry",
      "credit_limit_change",
      "repayment",
      "repayment_allocation",
      "approval",
      "approval_use",
    ];
    // A delivery itself can be corrected (which raises its version) but never deleted.
    expect(triggers.map((trigger) => trigger.name).sort()).toEqual(
      [
        ...addOnlyTables.flatMap((table) => [`${table}_no_delete`, `${table}_no_update`]),
        "goods_receipt_no_delete",
        "goods_receipt_guard_update",
        "document_counter_no_delete",
        "document_counter_only_up",
        "payment_method_no_delete",
        "payment_method_kind_fixed",
        "customer_no_delete",
      ].sort(),
    );

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
        "business_expiring_soon_months_check",
        "product_average_cost_check",
        "stock_balance_not_negative_check",
        "stock_movement_not_zero_check",
        "goods_receipt_backdate_note_check",
        "goods_receipt_line_amounts_check",
        "goods_receipt_version_reason_check",
        "stock_transfer_two_locations_check",
        "stock_transfer_line_amounts_check",
        "stock_count_line_amounts_check",
        "stock_adjustment_line_amounts_check",
        "stock_adjustment_decision_note_check",
        "sale_amounts_check",
        "sale_line_amounts_check",
        "payment_amounts_check",
        "document_counter_next_check",
        "payment_tender_is_cash_check",
        "payment_method_built_in_check",
        "till_session_float_check",
        "till_session_close_amounts_check",
        "till_session_recount_amounts_check",
        "sale_cancellation_note_check",
        "refund_amounts_check",
        "customer_amounts_check",
        "sale_credit_check",
        "customer_account_entry_amounts_check",
        "repayment_amounts_check",
        "repayment_allocation_amount_check",
        "sale_discount_check",
        "sale_line_discount_check",
        "approval_amounts_check",
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
