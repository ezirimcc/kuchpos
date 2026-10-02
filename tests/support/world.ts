import { randomUUID } from "node:crypto";
import { hashPassword } from "better-auth/crypto";
import type { Role } from "@/generated/prisma/client";
import type { AppContext } from "@/server/auth/context";
import { placeholderEmail } from "@/server/auth/config";
import { getDb } from "@/server/db/client";
import { BUSINESS_ROLES, type BusinessRole } from "@/server/permissions";

export const TEST_PASSWORD = "correct-horse-battery";

// Hashing is deliberately slow; do it once per test run and reuse the result.
let passwordHash: Promise<string> | undefined;
function testPasswordHash(): Promise<string> {
  passwordHash ??= hashPassword(TEST_PASSWORD);
  return passwordHash;
}

/** Empties every table of the TEST database. */
export async function resetDatabase(): Promise<void> {
  const url = new URL(process.env.DATABASE_URL ?? "");
  if (!url.pathname.endsWith("_test")) {
    throw new Error("resetDatabase() may only run against a database whose name ends in _test.");
  }
  await getDb().$executeRawUnsafe(
    'TRUNCATE "activity_log", "session", "account", "verification", "user", "business" CASCADE',
  );
}

export type TestUser = { id: string; name: string; username: string; role: Role };

export async function createUser(input: {
  username: string;
  role: Role;
  businessId: string | null;
}): Promise<TestUser> {
  const id = randomUUID();
  const user = await getDb().user.create({
    data: {
      id,
      name: `Test ${input.username}`,
      username: input.username,
      displayUsername: input.username,
      email: placeholderEmail(input.username),
      role: input.role,
      businessId: input.businessId,
      accounts: {
        create: {
          id: randomUUID(),
          accountId: id,
          providerId: "credential",
          password: await testPasswordHash(),
        },
      },
    },
  });
  return { id: user.id, name: user.name, username: user.username, role: user.role };
}

/** A context backed by a real session row, as if this user had just signed in. */
export async function contextFor(
  user: TestUser,
  business: { id: string; name: string } | null,
): Promise<AppContext> {
  const session = await getDb().session.create({
    data: {
      id: randomUUID(),
      token: randomUUID(),
      userId: user.id,
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      activeBusinessId: user.role === "OWNER" ? (business?.id ?? null) : null,
    },
  });
  return {
    actor: {
      userId: user.id,
      name: user.name,
      username: user.username,
      role: user.role,
      sessionId: session.id,
    },
    business,
  };
}

export type TestBusiness = {
  id: string;
  name: string;
  staff: Record<BusinessRole, TestUser>;
  /** A signed-in context for each role in this business. */
  as: Record<BusinessRole, AppContext>;
};

async function createBusiness(name: string, prefix: string): Promise<TestBusiness> {
  const business = await getDb().business.create({ data: { name, nameKey: name.toLowerCase() } });
  const ref = { id: business.id, name: business.name };
  const staff = {} as Record<BusinessRole, TestUser>;
  const as = {} as Record<BusinessRole, AppContext>;
  for (const role of BUSINESS_ROLES) {
    staff[role] = await createUser({
      username: `${prefix}.${role.toLowerCase()}`,
      role,
      businessId: business.id,
    });
    as[role] = await contextFor(staff[role], ref);
  }
  return { ...ref, staff, as };
}

export type World = {
  owner: TestUser;
  /** The owner with no business open. */
  ownerOutside: AppContext;
  /** The owner with business A open. */
  ownerInA: AppContext;
  a: TestBusiness;
  b: TestBusiness;
};

/** A fresh set of sample data: one owner and two businesses with one person per role in each. */
export async function createWorld(): Promise<World> {
  await resetDatabase();
  const owner = await createUser({ username: "owner", role: "OWNER", businessId: null });
  const a = await createBusiness("Business A", "a");
  const b = await createBusiness("Business B", "b");
  return {
    owner,
    ownerOutside: await contextFor(owner, null),
    ownerInA: await contextFor(owner, { id: a.id, name: a.name }),
    a,
    b,
  };
}
