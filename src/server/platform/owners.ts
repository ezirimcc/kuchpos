import "server-only";
import { z } from "zod";
import { activityRow } from "@/server/activity";
import type { AppContext } from "@/server/auth/context";
import {
  hashPassword,
  newUserData,
  parseInput,
  passwordSchema,
  personNameSchema,
  rethrowUsernameTaken,
  usernameSchema,
} from "@/server/auth/users";
import { getDb } from "@/server/db/client";
import { NotFoundError, ValidationError } from "@/server/errors";
import { authorize } from "@/server/permissions";

/** Owner-only operations on owner accounts and the system-level activity log. */

export type OwnerSummary = {
  id: string;
  name: string;
  username: string;
  active: boolean;
  createdAt: Date;
};

export async function listOwners(context: AppContext): Promise<OwnerSummary[]> {
  authorize(context, "owner.manage");
  const rows = await getDb().user.findMany({
    where: { role: "OWNER" },
    orderBy: { name: "asc" },
    select: { id: true, name: true, username: true, disabledAt: true, createdAt: true },
  });
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    username: row.username,
    active: row.disabledAt === null,
    createdAt: row.createdAt,
  }));
}

const createOwnerSchema = z.object({
  name: personNameSchema,
  username: usernameSchema,
  password: passwordSchema,
});

export async function createOwner(context: AppContext, input: unknown): Promise<{ id: string }> {
  authorize(context, "owner.manage");
  const data = parseInput(createOwnerSchema, input);
  const row = await newUserData({ ...data, role: "OWNER" });
  const db = getDb();

  try {
    return await db.$transaction(async (tx) => {
      const owner = await tx.user.create({ data: row });
      await tx.activityLog.create({
        data: {
          ...activityRow(context, {
            action: "owner.created",
            summary: `${context.actor.name} created the owner account "${owner.username}" for ${owner.name}.`,
            targetType: "user",
            targetId: owner.id,
          }),
          businessId: null,
        },
      });
      return { id: owner.id };
    });
  } catch (error) {
    rethrowUsernameTaken(error);
  }
}

const setOwnerDisabledSchema = z.object({ userId: z.string().min(1), disabled: z.boolean() });

/** Disabling an owner signs them out everywhere. The last active owner can never be disabled. */
export async function setOwnerDisabled(context: AppContext, input: unknown): Promise<void> {
  authorize(context, "owner.manage");
  const data = parseInput(setOwnerDisabledSchema, input);

  await getDb().$transaction(async (tx) => {
    // Lock the active owners so two requests cannot each disable "the other one" at the same moment.
    const activeOwners = await tx.$queryRaw<{ id: string }[]>`
      SELECT \`id\` FROM \`user\` WHERE \`role\` = 'OWNER' AND \`disabledAt\` IS NULL FOR UPDATE`;

    const owner = await tx.user.findFirst({ where: { id: data.userId, role: "OWNER" } });
    if (!owner) throw new NotFoundError("That owner could not be found.");
    if ((owner.disabledAt !== null) === data.disabled) return; // Already in the requested state.

    if (data.disabled) {
      const othersStillActive = activeOwners.some((row) => row.id !== owner.id);
      if (!othersStillActive) {
        throw new ValidationError(
          "This is the last active owner. Create another owner before disabling this one.",
        );
      }
      await tx.session.deleteMany({ where: { userId: owner.id } });
    }

    await tx.user.update({
      where: { id: owner.id },
      data: { disabledAt: data.disabled ? new Date() : null },
    });
    await tx.activityLog.create({
      data: {
        ...activityRow(context, {
          action: data.disabled ? "owner.disabled" : "owner.enabled",
          summary: `${context.actor.name} ${data.disabled ? "disabled" : "re-enabled"} the owner account "${owner.username}".`,
          targetType: "user",
          targetId: owner.id,
        }),
        businessId: null,
      },
    });
  });
}

const resetOwnerPasswordSchema = z.object({ userId: z.string().min(1), password: passwordSchema });

/** Sets a new password for an owner and signs them out everywhere. */
export async function resetOwnerPassword(context: AppContext, input: unknown): Promise<void> {
  authorize(context, "owner.manage");
  const data = parseInput(resetOwnerPasswordSchema, input);
  const db = getDb();

  const owner = await db.user.findFirst({ where: { id: data.userId, role: "OWNER" } });
  if (!owner) throw new NotFoundError("That owner could not be found.");
  const password = await hashPassword(data.password);

  await db.$transaction([
    db.account.updateMany({
      where: { userId: owner.id, providerId: "credential" },
      data: { password },
    }),
    db.session.deleteMany({ where: { userId: owner.id } }),
    db.activityLog.create({
      data: {
        ...activityRow(context, {
          action: "owner.password_reset",
          summary: `${context.actor.name} reset the password of the owner account "${owner.username}".`,
          targetType: "user",
          targetId: owner.id,
        }),
        businessId: null,
      },
    }),
  ]);
}

export type ActivityItem = {
  id: string;
  createdAt: Date;
  actorName: string;
  actorRole: string | null;
  action: string;
  summary: string;
};

/** System-level events: owners and businesses being created, disabled and so on. */
export async function listPlatformActivity(context: AppContext, limit = 200): Promise<ActivityItem[]> {
  authorize(context, "owner.manage");
  return getDb().activityLog.findMany({
    where: { businessId: null },
    orderBy: { createdAt: "desc" },
    take: Math.min(Math.max(limit, 1), 500),
    select: { id: true, createdAt: true, actorName: true, actorRole: true, action: true, summary: true },
  });
}
