import "server-only";
import { verifyPassword } from "better-auth/crypto";
import { z } from "zod";
import { activityRow } from "@/server/activity";
import { getDb } from "@/server/db/client";
import { ValidationError } from "@/server/errors";
import type { AppContext } from "./context";
import { hashPassword, parseInput, passwordSchema } from "./users";

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
