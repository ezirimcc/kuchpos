import { randomUUID } from "node:crypto";
import { hashPassword } from "better-auth/crypto";
import type { Role } from "@/generated/prisma/client";
import { emptyAllTables } from "../../prisma/empty-tables";
import type { AppContext } from "@/server/auth/context";
import { placeholderEmail } from "@/server/auth/config";
import { getDb } from "@/server/db/client";
import { defaultLocations, defaultTerminal } from "@/server/business/defaults";
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
  await emptyAllTables(getDb());
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

export type TestProduct = { id: string; baseUnitId: string; packUnitId: string };

export type TestBusiness = {
  id: string;
  name: string;
  /** A whole-unit product "single = 1, pack = 10" priced ₦100.00 and ₦900.00. */
  product: TestProduct;
  shelfId: string;
  storeroomId: string;
  supplierId: string;
  terminalId: string;
  /** The category the sample product is in, and a second one with no products. */
  categoryId: string;
  emptyCategoryId: string;
  staff: Record<BusinessRole, TestUser>;
  /** A signed-in context for each role in this business. */
  as: Record<BusinessRole, AppContext>;
};

async function createBusiness(name: string, prefix: string): Promise<TestBusiness> {
  const business = await getDb().business.create({ data: { name, nameKey: name.toLowerCase() } });
  await getDb().location.createMany({ data: defaultLocations(business.id) });
  const terminal = await getDb().terminal.create({ data: defaultTerminal(business.id) });
  const shelf = await getDb().location.findFirstOrThrow({ where: { businessId: business.id, kind: "SHELF" } });
  const storeroom = await getDb().location.findFirstOrThrow({ where: { businessId: business.id, kind: "STOREROOM" } });
  const supplier = await getDb().supplier.create({ data: { businessId: business.id, name: `${prefix.toUpperCase()} Supplies Ltd` } });
  const category = await getDb().category.create({ data: { businessId: business.id, name: "Seeds" } });
  const emptyCategory = await getDb().category.create({ data: { businessId: business.id, name: "Empty" } });
  const product = await getDb().product.create({
    data: {
      businessId: business.id,
      categoryId: category.id,
      name: `${prefix.toUpperCase()} Seed Sachet`,
      code: `${prefix.toUpperCase()}-001`,
      allowsFraction: false,
      units: {
        create: [
          { businessId: business.id, name: "single", activeName: "single", factor: "1", isBase: true, price: "100.00" },
          { businessId: business.id, name: "pack", activeName: "pack", factor: "10", price: "900.00" },
        ],
      },
    },
    include: { units: true },
  });
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
  return {
    ...ref,
    staff,
    as,
    shelfId: shelf.id,
    storeroomId: storeroom.id,
    supplierId: supplier.id,
    terminalId: terminal.id,
    categoryId: category.id,
    emptyCategoryId: emptyCategory.id,
    product: {
      id: product.id,
      baseUnitId: product.units.find((unit) => unit.isBase)!.id,
      packUnitId: product.units.find((unit) => !unit.isBase)!.id,
    },
  };
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

/**
 * Checks the golden rule of the stock ledger for the whole database: every balance equals
 * the sum of its movements, and there is no movement without a balance.
 */
export async function expectBalancesMatchMovements(): Promise<void> {
  const db = getDb();
  const mismatches = await db.$queryRaw<{ productId: string; locationId: string; balance: string; moved: string }[]>`
    SELECT k.productId, k.locationId,
           CAST(COALESCE(b.quantity, 0) AS CHAR) AS balance,
           CAST(COALESCE(m.moved, 0) AS CHAR) AS moved
    FROM (
      SELECT productId, locationId FROM stock_balance
      UNION
      SELECT productId, locationId FROM stock_movement
    ) k
    LEFT JOIN stock_balance b ON b.productId = k.productId AND b.locationId = k.locationId
    LEFT JOIN (
      SELECT productId, locationId, SUM(quantityDelta) AS moved FROM stock_movement GROUP BY productId, locationId
    ) m ON m.productId = k.productId AND m.locationId = k.locationId
    WHERE COALESCE(b.quantity, 0) <> COALESCE(m.moved, 0)`;
  if (mismatches.length > 0) {
    throw new Error(`Stock balances do not match their movements: ${JSON.stringify(mismatches)}`);
  }
}
