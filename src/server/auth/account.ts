import "server-only";
import { verifyPassword } from "better-auth/crypto";
import { z } from "zod";
import { activityRow } from "@/server/activity";
import { getDb } from "@/server/db/client";
import { ValidationError } from "@/server/errors";
import type { Role } from "@/generated/prisma/client";
import { OWNER_IDLE_SIGN_OUT_MINUTES } from "./config";
import type { AppContext } from "./context";
import { Prisma } from "@/generated/prisma/client";
import { placeholderEmail } from "./config";
import { hashPassword, parseInput, passwordSchema, personNameSchema, usernameSchema } from "./users";

/** Things any signed-in person may do to their OWN account. The account is always taken from the session. */

const changeOwnPasswordSchema = z.object({
  currentPassword: z.string().min(1, "Enter your current password."),
  newPassword: passwordSchema,
});

/**
 * Changes the signed-in person's own password. They must prove they know the
 * current one. Every other computer they are signed in on is signed out.
 */
export async function changeOwnPassword(context: AppContext, input: unknown): Promise<void> {
  const data = parseInput(changeOwnPasswordSchema, input);
  const db = getDb();
  const userId = context.actor.userId;

  const account = await db.account.findFirst({ where: { userId, providerId: "credential" } });
  const currentMatches =
    !!account?.password && (await verifyPassword({ hash: account.password, password: data.currentPassword }));
  if (!account || !currentMatches) {
    throw new ValidationError("Please correct the highlighted fields.", {
      currentPassword: "That is not your current password.",
    });
  }
  if (data.newPassword === data.currentPassword) {
    throw new ValidationError("Please correct the highlighted fields.", {
      newPassword: "Choose a password that is different from your current one.",
    });
  }

  const password = await hashPassword(data.newPassword);
  await db.$transaction([
    db.account.update({ where: { id: account.id }, data: { password } }),
    db.session.deleteMany({ where: { userId, id: { not: context.actor.sessionId } } }),
    db.activityLog.create({
      data: {
        ...activityRow(context, {
          action: "account.password_changed",
          summary: `${context.actor.name} changed their own password.`,
          targetType: "user",
          targetId: userId,
        }),
        // Staff: their own business's log. Owners: the system log.
        businessId: context.actor.role === "OWNER" ? null : (context.business?.id ?? null),
      },
    }),
  ]);
}

export type OwnProfile = {
  name: string;
  username: string;
  role: Role;
  /** The business the account belongs to; null for an owner. */
  businessName: string | null;
  accountCreatedAt: Date;
  /** When the current sign-in on this computer started. */
  signedInAt: Date | null;
  /** Minutes without use before this person is signed out automatically. */
  idleSignOutMinutes: number;
};

/** Basic information about the signed-in person's own account. */
export async function getOwnProfile(context: AppContext): Promise<OwnProfile> {
  const db = getDb();
  const [user, session] = await Promise.all([
    db.user.findUniqueOrThrow({
      where: { id: context.actor.userId },
      select: {
        name: true,
        username: true,
        role: true,
        createdAt: true,
        business: { select: { name: true, idleSignOutMinutes: true } },
      },
    }),
    db.session.findUnique({ where: { id: context.actor.sessionId }, select: { createdAt: true } }),
  ]);
  return {
    name: user.name,
    username: user.username,
    role: user.role,
    businessName: user.business?.name ?? null,
    accountCreatedAt: user.createdAt,
    signedInAt: session?.createdAt ?? null,
    idleSignOutMinutes: user.business?.idleSignOutMinutes ?? OWNER_IDLE_SIGN_OUT_MINUTES,
  };
}

const updateOwnProfileSchema = z.object({
  name: personNameSchema,
  username: usernameSchema,
  currentPassword: z.string().min(1, "Enter your current password to confirm the change."),
});

/**
 * Lets the signed-in person change their own full name and username. They must prove
 * they know their password, and the change is written to the activity log with the old
 * and new values. Role and business are never changed here.
 */
export async function updateOwnProfile(context: AppContext, input: unknown): Promise<void> {
  const data = parseInput(updateOwnProfileSchema, input);
  const db = getDb();
  const userId = context.actor.userId;

  const user = await db.user.findUniqueOrThrow({
    where: { id: userId },
    select: { name: true, username: true, role: true, businessId: true },
  });
  const nameChanged = user.name !== data.name;
  const usernameChanged = user.username !== data.username;
  if (!nameChanged && !usernameChanged) return;

  const account = await db.account.findFirst({ where: { userId, providerId: "credential" } });
  const passwordMatches =
    !!account?.password && (await verifyPassword({ hash: account.password, password: data.currentPassword }));
  if (!passwordMatches) {
    throw new ValidationError("Please correct the highlighted fields.", {
      currentPassword: "That is not your current password.",
    });
  }

  const changes = [
    nameChanged ? `name from "${user.name}" to "${data.name}"` : null,
    usernameChanged ? `username from "${user.username}" to "${data.username}"` : null,
  ].filter(Boolean);

  try {
    await db.$transaction([
      db.user.update({
        where: { id: userId },
        data: {
          name: data.name,
          ...(usernameChanged
            ? { username: data.username, displayUsername: data.username, email: placeholderEmail(data.username) }
            : {}),
        },
      }),
      db.activityLog.create({
        data: {
          actorUserId: userId,
          // The log shows the name the person had when they made the change.
          actorName: user.name,
          actorRole: user.role,
          action: "account.profile_changed",
          summary: `${user.name} changed their own ${changes.join(" and ")}.`,
          targetType: "user",
          targetId: userId,
          details: { from: { name: user.name, username: user.username }, to: { name: data.name, username: data.username } },
          businessId: user.businessId,
        },
      }),
    ]);
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      throw new ValidationError("Please correct the highlighted fields.", {
        username: "That username is already taken. Choose another.",
      });
    }
    throw error;
  }
}
