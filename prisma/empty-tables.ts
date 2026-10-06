import type { PrismaClient } from "../src/generated/prisma/client";

/**
 * Empties EVERY table. Used only by the sample-data seed and the automated tests,
 * and only against databases their callers have already checked are safe to wipe.
 *
 * Add-only tables refuse row deletions (database triggers), so everything is emptied
 * with TRUNCATE, with foreign-key checks switched off for this one connection.
 * When a table is added to the schema, add it to this list.
 */
const TABLES = [
  "activity_log",
  "stock_movement",
  "stock_transfer_line",
  "stock_transfer",
  "goods_receipt_change",
  "goods_receipt_version_line",
  "goods_receipt_version",
  "goods_receipt_line",
  "goods_receipt",
  "stock_balance",
  "supplier",
  "price_change",
  "tax_rate_change",
  "product_unit",
  "product",
  "category",
  "terminal",
  "location",
  "rateLimit",
  "session",
  "account",
  "verification",
  "user",
  "business",
];

export async function emptyAllTables(db: PrismaClient): Promise<void> {
  // One pinned connection, so the switch applies to the statements that follow it.
  await db.$transaction(async (tx) => {
    await tx.$executeRawUnsafe("SET FOREIGN_KEY_CHECKS = 0");
    try {
      for (const table of TABLES) {
        await tx.$executeRawUnsafe(`TRUNCATE TABLE \`${table}\``);
      }
    } finally {
      await tx.$executeRawUnsafe("SET FOREIGN_KEY_CHECKS = 1");
    }
  });
}
