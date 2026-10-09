import "server-only";
import { verifyPassword } from "better-auth/crypto";
import type { Role } from "@/generated/prisma/client";
import { getDb } from "@/server/db/client";
import { type Permission, roleHasPermission } from "@/server/permissions";

/**
 * Checking a SECOND person at someone else's screen: a manager who types their own username
 * and password at the cashier's checkout to approve something. Nobody is signed in by this;
 * it only answers "is this really that person, and may they approve this, here?".
 *
 * The approver must be an active account of this business (or an active owner) whose role
 * holds the permission. The answer never says which part was wrong.
 */
export async function verifyApprover(input: {
  username: string;
  password: string;
  businessId: string;
  permission: Permission;
}): Promise<{ userId: string; name: string; role: Role } | null> {
  const db = getDb();
  const user = await db.user.findUnique({
    where: { username: input.username.trim().toLowerCase() },
    select: { id: true, name: true, role: true, businessId: true, disabledAt: true },
  });
  const account = user ? await db.account.findFirst({ where: { userId: user.id, providerId: "credential" } }) : null;
  const passwordMatches = !!account?.password && (await verifyPassword({ hash: account.password, password: input.password }));
  if (!user || !passwordMatches) return null;
  if (user.disabledAt) return null;
  if (user.role !== "OWNER" && user.businessId !== input.businessId) return null;
  if (!roleHasPermission(user.role, input.permission)) return null;
  return { userId: user.id, name: user.name, role: user.role };
}

/**
 * The account an offline pass names, as it stands now. The pass says who made a sale during
 * an outage; this says whether that person still exists, where they belong and whether the
 * account has been disabled since.
 */
export async function findCashier(
  userId: string,
): Promise<{ id: string; name: string; username: string; role: Role; businessId: string | null; disabledAt: Date | null } | null> {
  return getDb().user.findUnique({
    where: { id: userId },
    select: { id: true, name: true, username: true, role: true, businessId: true, disabledAt: true },
  });
}
