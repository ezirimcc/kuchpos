import "server-only";
import { randomUUID } from "node:crypto";
import type { AppContext } from "@/server/auth/context";
import { getDb } from "@/server/db/client";
import { authorize } from "@/server/permissions";

/**
 * Owner-only health report for the server the app is running on. Used after
 * each upload to confirm that the hosting server behaves as the app expects.
 */

export type SystemCheck = {
  appVersion: string;
  environment: string;
  nodeVersion: string;
  memoryMegabytes: number;
  databaseVersion: string;
  databaseTimeZone: string;
  /** How the hosting server reports the visitor to the app. */
  visitorAddress: string | null;
  visitorConnection: string | null;
  /** Rules the database must enforce by itself. Each is tried for real, then undone. */
  rules: { name: string; enforced: boolean }[];
};

class RollBack extends Error {}

/** Tables whose rows may never be changed or deleted; each has a "no update" and a "no delete" trigger. */
const ADD_ONLY_TABLES = [
  "activity_log",
  "price_change",
  "tax_rate_change",
  "stock_movement",
  "goods_receipt",
  "goods_receipt_line",
];

/** Limits written into the database itself (CHECK constraints). */
const REQUIRED_CHECKS = [
  "user_owner_has_no_business_check",
  "user_username_lowercase_check",
  "business_idle_sign_out_minutes_check",
  "business_tax_rate_percent_check",
  "business_expiring_soon_months_check",
  "terminal_code_format_check",
  "product_unit_factor_check",
  "product_unit_price_check",
  "product_average_cost_check",
  "stock_balance_not_negative_check",
  "stock_movement_not_zero_check",
  "goods_receipt_backdate_note_check",
  "goods_receipt_line_amounts_check",
];

function readAppVersion(): string {
  // Set by the start-up file on the hosting server (hosting/app.js) from VERSION.txt.
  // Deliberately not read from disk here: file access in app code makes the build copy
  // the whole project folder into the upload bundle.
  return process.env.KUCHPOS_VERSION ?? "development";
}

async function refuses(attempt: () => Promise<unknown>): Promise<boolean> {
  try {
    await attempt();
    return false;
  } catch {
    return true;
  }
}

export async function getSystemCheck(
  context: AppContext,
  request: { forwardedFor: string | null; forwardedProto: string | null },
): Promise<SystemCheck> {
  authorize(context, "owner.manage");
  const db = getDb();

  const [info] = await db.$queryRaw<{ version: string; zone: string }[]>`
    SELECT VERSION() AS version, @@session.time_zone AS zone`;

  const rules: SystemCheck["rules"] = [];
  try {
    // Everything in here is undone at the end: it only proves the database says "no".
    await db.$transaction(async (tx) => {
      const businessId = randomUUID();
      await tx.business.create({
        data: { id: businessId, name: `System check ${businessId}`, nameKey: `system check ${businessId}` },
      });
      const entry = await tx.activityLog.create({
        data: { businessId, actorName: "System check", action: "system.check", summary: "Temporary entry." },
      });

      rules.push({
        name: "Activity log entries cannot be changed",
        enforced: await refuses(() =>
          tx.$executeRaw`UPDATE \`activity_log\` SET \`summary\` = 'changed' WHERE \`id\` = ${entry.id}`,
        ),
      });
      rules.push({
        name: "Activity log entries cannot be deleted",
        enforced: await refuses(() => tx.$executeRaw`DELETE FROM \`activity_log\` WHERE \`id\` = ${entry.id}`),
      });
      rules.push({
        name: "Automatic sign-out time must be 5 to 480 minutes",
        enforced: await refuses(() =>
          tx.$executeRaw`UPDATE \`business\` SET \`idleSignOutMinutes\` = 2 WHERE \`id\` = ${businessId}`,
        ),
      });
      rules.push({
        name: "Staff must belong to a business",
        enforced: await refuses(() =>
          tx.$executeRaw`UPDATE \`user\` SET \`businessId\` = ${businessId} WHERE \`id\` = ${context.actor.userId}`,
        ),
      });

      throw new RollBack();
    });
  } catch (error) {
    if (!(error instanceof RollBack)) throw error;
  }

  // The remaining rules are confirmed to be installed (trying each one for real would need sample stock).
  const triggers = await db.$queryRaw<{ name: string }[]>`
    SELECT TRIGGER_NAME AS name FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA = DATABASE()`;
  const checks = await db.$queryRaw<{ name: string }[]>`
    SELECT CONSTRAINT_NAME AS name FROM information_schema.CHECK_CONSTRAINTS WHERE CONSTRAINT_SCHEMA = DATABASE()`;
  const installedTriggers = new Set(triggers.map((row) => row.name));
  const installedChecks = new Set(checks.map((row) => row.name));
  const expectedTriggers = ADD_ONLY_TABLES.flatMap((table) => [`${table}_no_update`, `${table}_no_delete`]);
  rules.push({
    name: `Stock, price and delivery history cannot be changed or deleted (${expectedTriggers.length} protections installed)`,
    enforced: expectedTriggers.every((name) => installedTriggers.has(name)),
  });
  rules.push({
    name: `Stock cannot go below zero, and the other limits on amounts (${REQUIRED_CHECKS.length} limits installed)`,
    enforced: REQUIRED_CHECKS.every((name) => installedChecks.has(name)),
  });

  return {
    appVersion: readAppVersion(),
    environment: process.env.KUCHPOS_ENVIRONMENT === "test" ? "Test site (sample data)" : "Not marked as a test site",
    nodeVersion: process.version,
    memoryMegabytes: Math.round(process.memoryUsage().rss / 1024 / 1024),
    databaseVersion: info?.version ?? "unknown",
    databaseTimeZone: info?.zone ?? "unknown",
    visitorAddress: request.forwardedFor?.split(",")[0]?.trim() || null,
    visitorConnection: request.forwardedProto,
    rules,
  };
}
