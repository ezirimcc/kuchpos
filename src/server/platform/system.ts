import "server-only";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
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

function readAppVersion(): string {
  // VERSION.txt sits beside the "build" folder in the uploaded bundle.
  for (const candidate of [join(process.cwd(), "..", "VERSION.txt"), join(process.cwd(), "VERSION.txt")]) {
    try {
      return readFileSync(candidate, "utf8").split("\n")[0].trim();
    } catch {
      // Try the next place.
    }
  }
  return "development";
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
