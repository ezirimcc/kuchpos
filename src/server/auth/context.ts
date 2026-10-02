import "server-only";
import type { Role } from "@/generated/prisma/client";
import { getDb } from "@/server/db/client";
import { NotSignedInError } from "@/server/errors";
import { getAuth } from "./auth";
import { LAST_ACTIVE_WRITE_INTERVAL_MS, OWNER_IDLE_SIGN_OUT_MINUTES } from "./config";

/** Who is making this request, and which business they are working in. */
export type AppContext = {
  actor: {
    userId: string;
    name: string;
    username: string;
    role: Role;
    sessionId: string;
  };
  /**
   * The business in use. For staff: always their own business.
   * For an owner: the business they have opened, or null if none is open.
   */
  business: { id: string; name: string } | null;
};

/**
 * Works out who is asking, from the request's cookies — never from anything
 * else the browser sends. Re-checked on every request, so a disabled account or
 * a deactivated business is locked out immediately.
 */
export async function resolveContext(headers: Headers): Promise<AppContext> {
  const session = await getAuth().api.getSession({ headers });
  if (!session) throw new NotSignedInError();

  const db = getDb();
  const row = await db.session.findUnique({
    where: { id: session.session.id },
    select: {
      id: true,
      lastActiveAt: true,
      activeBusiness: { select: { id: true, name: true, deactivatedAt: true } },
      user: {
        select: {
          id: true,
          name: true,
          username: true,
          role: true,
          disabledAt: true,
          business: { select: { id: true, name: true, deactivatedAt: true, idleSignOutMinutes: true } },
        },
      },
    },
  });
  if (!row) throw new NotSignedInError();

  const { user } = row;
  const actor = {
    userId: user.id,
    name: user.name,
    username: user.username,
    role: user.role,
    sessionId: row.id,
  };

  if (user.disabledAt) {
    await db.session.deleteMany({ where: { userId: user.id } });
    throw new NotSignedInError("This account has been disabled.", "disabled");
  }

  // Automatic sign-out: staff follow their business's setting; owners have a fixed time.
  const idleMinutes =
    user.role === "OWNER" ? OWNER_IDLE_SIGN_OUT_MINUTES : (user.business?.idleSignOutMinutes ?? 0);
  const idleFor = Date.now() - row.lastActiveAt.getTime();
  if (idleFor > idleMinutes * 60 * 1000) {
    await db.session.deleteMany({ where: { id: row.id } });
    throw new NotSignedInError("You were signed out because the screen was not used for a while.", "idle");
  }
  if (idleFor > LAST_ACTIVE_WRITE_INTERVAL_MS) {
    await db.session.updateMany({ where: { id: row.id }, data: { lastActiveAt: new Date() } });
  }

  if (user.role === "OWNER") {
    const open = row.activeBusiness;
    if (open?.deactivatedAt) {
      // The business was deactivated while the owner had it open: close it.
      await db.session.update({ where: { id: row.id }, data: { activeBusinessId: null } });
      return { actor, business: null };
    }
    return { actor, business: open ? { id: open.id, name: open.name } : null };
  }

  const business = user.business;
  if (!business || business.deactivatedAt) {
    await db.session.deleteMany({ where: { userId: user.id } });
    throw new NotSignedInError("This business has been deactivated.", "disabled");
  }
  return { actor, business: { id: business.id, name: business.name } };
}
