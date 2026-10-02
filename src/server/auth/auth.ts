import "server-only";
import { betterAuth } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { APIError } from "better-auth/api";
import { username } from "better-auth/plugins";
import { getDb } from "@/server/db/client";
import {
  MAX_PASSWORD_LENGTH,
  MAX_USERNAME_LENGTH,
  MIN_PASSWORD_LENGTH,
  MIN_USERNAME_LENGTH,
  SESSION_IDLE_SECONDS,
  SESSION_REFRESH_SECONDS,
  USERNAME_PATTERN,
} from "./config";

function createAuth() {
  const db = getDb();

  return betterAuth({
    database: prismaAdapter(db, { provider: "mysql" }),

    // Username + password only. Accounts are created by owners and admins; there is no public sign-up.
    emailAndPassword: {
      enabled: true,
      disableSignUp: true,
      minPasswordLength: MIN_PASSWORD_LENGTH,
      maxPasswordLength: MAX_PASSWORD_LENGTH,
    },
    plugins: [
      username({
        minUsernameLength: MIN_USERNAME_LENGTH,
        maxUsernameLength: MAX_USERNAME_LENGTH,
        // People may type capitals when signing in; usernames are stored and compared in lower case.
        usernameValidator: (value) => USERNAME_PATTERN.test(value.toLowerCase()),
      }),
    ],

    // Sessions live in the database, so disabling an account takes effect at once.
    session: {
      expiresIn: SESSION_IDLE_SECONDS,
      updateAge: SESSION_REFRESH_SECONDS,
    },

    databaseHooks: {
      session: {
        create: {
          // Runs after the password has been checked, just before the person is signed in.
          before: async (session) => {
            const user = await db.user.findUnique({
              where: { id: session.userId },
              select: { disabledAt: true, business: { select: { deactivatedAt: true } } },
            });
            if (!user || user.disabledAt) {
              throw new APIError("FORBIDDEN", {
                message: "This account has been disabled. Ask your admin for help.",
              });
            }
            if (user.business?.deactivatedAt) {
              throw new APIError("FORBIDDEN", {
                message: "This business has been deactivated. Ask the owner for help.",
              });
            }
          },
          after: async (session) => {
            const user = await db.user.findUnique({
              where: { id: session.userId },
              select: { id: true, name: true, role: true, businessId: true },
            });
            if (!user) return;
            await db.activityLog.create({
              data: {
                businessId: user.businessId,
                actorUserId: user.id,
                actorName: user.name,
                actorRole: user.role,
                action: "auth.signed_in",
                summary: `${user.name} signed in.`,
              },
            });
          },
        },
      },
    },
  });
}

type Auth = ReturnType<typeof createAuth>;
const globalForAuth = globalThis as unknown as { kuchposAuth?: Auth };

export function getAuth(): Auth {
  if (!globalForAuth.kuchposAuth) {
    globalForAuth.kuchposAuth = createAuth();
  }
  return globalForAuth.kuchposAuth;
}

/**
 * The only login-library web addresses KuchPos exposes. Everything else the
 * library offers (sign-up, changing email or username, deleting an account…)
 * is switched off by not being on this list.
 */
export const ALLOWED_AUTH_PATHS: ReadonlyArray<{ method: "GET" | "POST"; path: string }> = [
  { method: "POST", path: "/api/auth/sign-in/username" },
  { method: "POST", path: "/api/auth/sign-out" },
  { method: "GET", path: "/api/auth/get-session" },
];
