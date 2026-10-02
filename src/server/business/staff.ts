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
import { businessDb } from "@/server/db/scoped";
import { NotFoundError, ValidationError } from "@/server/errors";
import { authorize, BUSINESS_ROLES, type BusinessRole, ROLE_LABELS } from "@/server/permissions";

/** Staff accounts of the business in use. Every query goes through the scoped client. */

const roleSchema = z.enum(BUSINESS_ROLES as [BusinessRole, ...BusinessRole[]], {
  error: "Choose a role.",
});
const userIdSchema = z.string().min(1, "That staff member could not be found.");

const STAFF_NOT_FOUND = "That staff member could not be found.";

export type StaffSummary = {
  id: string;
  name: string;
  username: string;
  role: BusinessRole;
  active: boolean;
  createdAt: Date;
};

export async function listStaff(context: AppContext): Promise<StaffSummary[]> {
  authorize(context, "staff.manage");
  const rows = await businessDb(context).user.findMany({
    orderBy: [{ disabledAt: { sort: "asc", nulls: "first" } }, { name: "asc" }],
    select: { id: true, name: true, username: true, role: true, disabledAt: true, createdAt: true },
  });
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    username: row.username,
    role: row.role as BusinessRole,
    active: row.disabledAt === null,
    createdAt: row.createdAt,
  }));
}

const createStaffSchema = z.object({
  name: personNameSchema,
  username: usernameSchema,
  password: passwordSchema,
  role: roleSchema,
});

export async function createStaff(context: AppContext, input: unknown): Promise<{ id: string }> {
  authorize(context, "staff.manage");
  const data = parseInput(createStaffSchema, input);
  const row = await newUserData(data);

  try {
    return await businessDb(context).$transaction(async (tx) => {
      const staff = await tx.user.create({ data: row });
      await tx.activityLog.create({
        data: activityRow(context, {
          action: "staff.created",
          summary: `${context.actor.name} created the ${ROLE_LABELS[data.role].toLowerCase()} account "${staff.username}" for ${staff.name}.`,
          targetType: "user",
          targetId: staff.id,
        }),
      });
      return { id: staff.id };
    });
  } catch (error) {
    rethrowUsernameTaken(error);
  }
}

const setStaffRoleSchema = z.object({ userId: userIdSchema, role: roleSchema });

export async function setStaffRole(context: AppContext, input: unknown): Promise<void> {
  authorize(context, "staff.manage");
  const data = parseInput(setStaffRoleSchema, input);
  if (data.userId === context.actor.userId) {
    throw new ValidationError("You cannot change your own role. Ask another admin or the owner.");
  }

  await businessDb(context).$transaction(async (tx) => {
    const staff = await tx.user.findFirst({ where: { id: data.userId } });
    if (!staff) throw new NotFoundError(STAFF_NOT_FOUND);
    if (staff.role === data.role) return;

    await tx.user.update({ where: { id: staff.id }, data: { role: data.role } });
    await tx.activityLog.create({
      data: activityRow(context, {
        action: "staff.role_changed",
        summary: `${context.actor.name} changed the role of "${staff.username}" from ${ROLE_LABELS[staff.role]} to ${ROLE_LABELS[data.role]}.`,
        targetType: "user",
        targetId: staff.id,
        details: { from: staff.role, to: data.role },
      }),
    });
  });
}

const setStaffDisabledSchema = z.object({ userId: userIdSchema, disabled: z.boolean() });

/** Disabling an account signs the person out everywhere, immediately. Accounts are never deleted. */
export async function setStaffDisabled(context: AppContext, input: unknown): Promise<void> {
  authorize(context, "staff.manage");
  const data = parseInput(setStaffDisabledSchema, input);
  if (data.userId === context.actor.userId) {
    throw new ValidationError("You cannot disable your own account. Ask another admin or the owner.");
  }

  await businessDb(context).$transaction(async (tx) => {
    const staff = await tx.user.findFirst({ where: { id: data.userId } });
    if (!staff) throw new NotFoundError(STAFF_NOT_FOUND);
    if ((staff.disabledAt !== null) === data.disabled) return; // Already in the requested state.

    await tx.user.update({
      where: { id: staff.id },
      data: { disabledAt: data.disabled ? new Date() : null },
    });
    if (data.disabled) {
      await tx.session.deleteMany({ where: { userId: staff.id } });
    }
    await tx.activityLog.create({
      data: activityRow(context, {
        action: data.disabled ? "staff.disabled" : "staff.enabled",
        summary: `${context.actor.name} ${data.disabled ? "disabled" : "re-enabled"} the account "${staff.username}".`,
        targetType: "user",
        targetId: staff.id,
      }),
    });
  });
}

const resetStaffPasswordSchema = z.object({ userId: userIdSchema, password: passwordSchema });

/** Sets a new password and signs the person out everywhere. */
export async function resetStaffPassword(context: AppContext, input: unknown): Promise<void> {
  authorize(context, "staff.manage");
  const data = parseInput(resetStaffPasswordSchema, input);
  const db = businessDb(context);

  const staff = await db.user.findFirst({ where: { id: data.userId } });
  if (!staff) throw new NotFoundError(STAFF_NOT_FOUND);
  const password = await hashPassword(data.password);

  await db.$transaction(async (tx) => {
    await tx.account.updateMany({
      where: { userId: staff.id, providerId: "credential" },
      data: { password },
    });
    await tx.session.deleteMany({ where: { userId: staff.id } });
    await tx.activityLog.create({
      data: activityRow(context, {
        action: "staff.password_reset",
        summary: `${context.actor.name} reset the password of "${staff.username}".`,
        targetType: "user",
        targetId: staff.id,
      }),
    });
  });
}
