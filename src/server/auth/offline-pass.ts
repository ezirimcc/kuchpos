import "server-only";
import { createHmac, timingSafeEqual } from "node:crypto";
import type { Role } from "@/generated/prisma/client";
import { shopDayEnd, shopToday } from "@/lib/format";
import type { AppContext } from "./context";

/**
 * An "offline pass": a note the server signs for a cashier while they are online, saying who
 * they are and until when they may sell without internet. The checkout computer keeps it and
 * sends it back with every sale made offline. Because only the server can sign one, the
 * server knows who really made a sale that arrives hours later — even if someone else is
 * signed in by then — and a pass cannot be made up or altered on the computer.
 *
 * It is not a sign-in: it opens nothing, and is only read when an offline sale is sent by
 * someone who IS signed in.
 */
export type OfflinePass = {
  userId: string;
  name: string;
  role: Role;
  businessId: string;
  /** When it was signed, and the last moment a sale may be made with it. */
  issuedAt: Date;
  expiresAt: Date;
};

function signature(payload: string): Buffer {
  const secret = process.env.BETTER_AUTH_SECRET;
  if (!secret) throw new Error("BETTER_AUTH_SECRET is not set.");
  // The prefix keeps this use of the secret apart from every other.
  return createHmac("sha256", secret).update(`kuchpos-offline-pass:${payload}`).digest();
}

/** The end of the shop day after the given moment: how long a cashier may sell without internet (C60). */
export function offlineUntil(now: Date = new Date()): Date {
  const tomorrow = shopToday(new Date(now.getTime() + 24 * 60 * 60 * 1000));
  return shopDayEnd(tomorrow)!;
}

/** Signs a pass for the signed-in person in the business in use. */
export function issueOfflinePass(context: AppContext, now: Date = new Date()): { token: string; expiresAt: Date } {
  if (!context.business) throw new Error("An offline pass needs a business.");
  const expiresAt = offlineUntil(now);
  const payload = Buffer.from(
    JSON.stringify({
      u: context.actor.userId,
      n: context.actor.name,
      r: context.actor.role,
      b: context.business.id,
      i: now.getTime(),
      e: expiresAt.getTime(),
    }),
  ).toString("base64url");
  return { token: `${payload}.${signature(payload).toString("base64url")}`, expiresAt };
}

/** Reads a pass. Null unless it was signed by this server and is whole. Expiry is for the caller to judge. */
export function readOfflinePass(token: string): OfflinePass | null {
  const [payload, signed, ...rest] = token.split(".");
  if (!payload || !signed || rest.length > 0) return null;
  const given = Buffer.from(signed, "base64url");
  const expected = signature(payload);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Record<string, unknown>;
    if (typeof data.u !== "string" || typeof data.n !== "string" || typeof data.r !== "string" || typeof data.b !== "string") return null;
    if (typeof data.i !== "number" || typeof data.e !== "number") return null;
    return { userId: data.u, name: data.n, role: data.r as Role, businessId: data.b, issuedAt: new Date(data.i), expiresAt: new Date(data.e) };
  } catch {
    return null;
  }
}
