import { beforeEach, describe, expect, it } from "vitest";
import type { AppContext } from "@/server/auth/context";
import * as activityLog from "@/server/business/activity-log";
import * as catalog from "@/server/business/catalog";
import * as setup from "@/server/business/setup";
import * as settings from "@/server/business/settings";
import * as staff from "@/server/business/staff";
import { getDb } from "@/server/db/client";
import { ForbiddenError, NotFoundError } from "@/server/errors";
import * as businesses from "@/server/platform/businesses";
import * as owners from "@/server/platform/owners";
import * as system from "@/server/platform/system";
import { createUser, createWorld, type World } from "../support/world";

/**
 * Calls every server operation directly — no screens involved — as each kind
 * of person, and checks that only the allowed ones get through.
 */

let world: World;
beforeEach(async () => {
  world = await createWorld();
});

type Actor =
  | "ownerOutside"
  | "ownerInA"
  | "ADMIN"
  | "MANAGER"
  | "ACCOUNTANT"
  | "CASHIER"
  | "STOREKEEPER";

const ALL_ACTORS: Actor[] = [
  "ownerOutside",
  "ownerInA",
  "ADMIN",
  "MANAGER",
  "ACCOUNTANT",
  "CASHIER",
  "STOREKEEPER",
];

function contextOf(actor: Actor): AppContext {
  if (actor === "ownerOutside") return world.ownerOutside;
  if (actor === "ownerInA") return world.ownerInA;
  return world.a.as[actor];
}

type Operation = {
  name: string;
  /** Who is allowed. Everyone else must be refused. */
  allowed: Actor[];
  /** Runs the operation with valid input aimed at business A (or at the platform). */
  run: (context: AppContext) => Promise<unknown>;
  /** For operations that take a record id: the same call aimed at business B's record. */
  runAgainstB?: (context: AppContext) => Promise<unknown>;
};

let counter = 0;
const unique = (prefix: string) => `${prefix}${++counter}`;

const BUSINESS_ADMINS: Actor[] = ["ownerInA", "ADMIN"];
const EVERYONE_IN_A: Actor[] = ["ownerInA", "ADMIN", "MANAGER", "ACCOUNTANT", "CASHIER", "STOREKEEPER"];
const PRODUCT_MANAGERS: Actor[] = ["ownerInA", "ADMIN", "MANAGER"];
const OWNERS: Actor[] = ["ownerOutside", "ownerInA"];

const OPERATIONS: Operation[] = [
  // --- Staff (SPEC §5: "Create / disable staff accounts, set roles, reset passwords") ---
  {
    name: "staff.listStaff",
    allowed: BUSINESS_ADMINS,
    run: (context) => staff.listStaff(context),
  },
  {
    name: "staff.createStaff",
    allowed: BUSINESS_ADMINS,
    run: (context) =>
      staff.createStaff(context, {
        name: "New Person",
        username: unique("new.person"),
        password: "a-good-password",
        role: "CASHIER",
      }),
  },
  {
    name: "staff.setStaffRole",
    allowed: BUSINESS_ADMINS,
    run: (context) => staff.setStaffRole(context, { userId: world.a.staff.CASHIER.id, role: "MANAGER" }),
    runAgainstB: (context) =>
      staff.setStaffRole(context, { userId: world.b.staff.CASHIER.id, role: "MANAGER" }),
  },
  {
    name: "staff.setStaffDisabled",
    allowed: BUSINESS_ADMINS,
    run: (context) => staff.setStaffDisabled(context, { userId: world.a.staff.STOREKEEPER.id, disabled: true }),
    runAgainstB: (context) =>
      staff.setStaffDisabled(context, { userId: world.b.staff.STOREKEEPER.id, disabled: true }),
  },
  {
    name: "staff.resetStaffPassword",
    allowed: BUSINESS_ADMINS,
    run: (context) =>
      staff.resetStaffPassword(context, { userId: world.a.staff.CASHIER.id, password: "another-password" }),
    runAgainstB: (context) =>
      staff.resetStaffPassword(context, { userId: world.b.staff.CASHIER.id, password: "another-password" }),
  },
  // --- Settings (SPEC §5: "Change business settings") ---
  {
    name: "settings.getBusinessSettings",
    allowed: BUSINESS_ADMINS,
    run: (context) => settings.getBusinessSettings(context),
  },
  {
    name: "settings.setIdleSignOutMinutes",
    allowed: BUSINESS_ADMINS,
    run: (context) => settings.setIdleSignOutMinutes(context, { minutes: "45" }),
  },
  {
    name: "settings.setTaxRate",
    allowed: BUSINESS_ADMINS,
    run: (context) => settings.setTaxRate(context, { ratePercent: "7.5" }),
  },
  {
    name: "settings.setReceiptText",
    allowed: BUSINESS_ADMINS,
    run: (context) => settings.setReceiptText(context, { header: "12 Market Road", footer: "Thank you" }),
  },
  // --- Locations and terminals (SPEC §5: "Create locations and terminals") ---
  {
    name: "setup.getSetup",
    allowed: BUSINESS_ADMINS,
    run: (context) => setup.getSetup(context),
  },
  {
    name: "setup.renameLocation",
    allowed: BUSINESS_ADMINS,
    run: (context) => setup.renameLocation(context, { locationId: world.a.shelfId, name: "Front shelf" }),
    runAgainstB: (context) => setup.renameLocation(context, { locationId: world.b.shelfId, name: "Front shelf" }),
  },
  {
    name: "setup.createTerminal",
    allowed: BUSINESS_ADMINS,
    run: (context) => setup.createTerminal(context, { code: unique("T"), name: "Checkout 2", paperWidth: "MM58" }),
  },
  {
    name: "setup.updateTerminal",
    allowed: BUSINESS_ADMINS,
    run: (context) =>
      setup.updateTerminal(context, { terminalId: world.a.terminalId, name: "Front till", paperWidth: "MM58" }),
    runAgainstB: (context) =>
      setup.updateTerminal(context, { terminalId: world.b.terminalId, name: "Front till", paperWidth: "MM58" }),
  },
  {
    name: "setup.setTerminalActive",
    allowed: BUSINESS_ADMINS,
    run: (context) => setup.setTerminalActive(context, { terminalId: world.a.terminalId, active: false }),
    runAgainstB: (context) => setup.setTerminalActive(context, { terminalId: world.b.terminalId, active: false }),
  },
  // --- Products and prices (SPEC §5: "Products & prices") ---
  {
    name: "catalog.listProducts",
    allowed: EVERYONE_IN_A,
    run: (context) => catalog.listProducts(context),
  },
  {
    name: "catalog.getProduct",
    allowed: EVERYONE_IN_A,
    run: (context) => catalog.getProduct(context, { productId: world.a.product.id }),
    runAgainstB: (context) => catalog.getProduct(context, { productId: world.b.product.id }),
  },
  {
    name: "catalog.listCategories",
    allowed: EVERYONE_IN_A,
    run: (context) => catalog.listCategories(context),
  },
  {
    name: "catalog.createCategory",
    allowed: PRODUCT_MANAGERS,
    run: (context) => catalog.createCategory(context, { name: unique("Category ") }),
  },
  {
    name: "catalog.renameCategory",
    allowed: PRODUCT_MANAGERS,
    run: (context) => catalog.renameCategory(context, { categoryId: world.a.categoryId, name: "Renamed" }),
    runAgainstB: (context) => catalog.renameCategory(context, { categoryId: world.b.categoryId, name: "Renamed" }),
  },
  {
    name: "catalog.removeCategory",
    allowed: PRODUCT_MANAGERS,
    run: (context) => catalog.removeCategory(context, { categoryId: world.a.emptyCategoryId }),
    runAgainstB: (context) => catalog.removeCategory(context, { categoryId: world.b.emptyCategoryId }),
  },
  {
    name: "catalog.createProduct",
    allowed: PRODUCT_MANAGERS,
    run: (context) =>
      catalog.createProduct(context, {
        name: unique("Product "),
        code: "",
        barcode: "",
        baseUnitName: "single",
        allowsFraction: false,
        taxable: true,
        baseForSale: true,
        basePrice: "250",
      }),
  },
  {
    name: "catalog.updateProduct",
    allowed: PRODUCT_MANAGERS,
    run: (context) =>
      catalog.updateProduct(context, { productId: world.a.product.id, name: "Renamed", code: "", barcode: "", taxable: false }),
    runAgainstB: (context) =>
      catalog.updateProduct(context, { productId: world.b.product.id, name: "Renamed", code: "", barcode: "", taxable: false }),
  },
  {
    name: "catalog.setProductActive",
    allowed: PRODUCT_MANAGERS,
    run: (context) => catalog.setProductActive(context, { productId: world.a.product.id, active: false }),
    runAgainstB: (context) => catalog.setProductActive(context, { productId: world.b.product.id, active: false }),
  },
  {
    name: "catalog.addUnit",
    allowed: PRODUCT_MANAGERS,
    run: (context) =>
      catalog.addUnit(context, {
        productId: world.a.product.id,
        name: "carton",
        factor: "100",
        forSale: true,
        forPurchase: true,
        price: "8500",
      }),
    runAgainstB: (context) =>
      catalog.addUnit(context, {
        productId: world.b.product.id,
        name: "carton",
        factor: "100",
        forSale: true,
        forPurchase: true,
        price: "8500",
      }),
  },
  {
    name: "catalog.setUnitPrice",
    allowed: PRODUCT_MANAGERS,
    run: (context) => catalog.setUnitPrice(context, { unitId: world.a.product.packUnitId, price: "950" }),
    runAgainstB: (context) => catalog.setUnitPrice(context, { unitId: world.b.product.packUnitId, price: "950" }),
  },
  {
    name: "catalog.setUnitUsage",
    allowed: PRODUCT_MANAGERS,
    run: (context) =>
      catalog.setUnitUsage(context, { unitId: world.a.product.packUnitId, forSale: false, forPurchase: true, price: "" }),
    runAgainstB: (context) =>
      catalog.setUnitUsage(context, { unitId: world.b.product.packUnitId, forSale: false, forPurchase: true, price: "" }),
  },
  {
    name: "catalog.retireUnit",
    allowed: PRODUCT_MANAGERS,
    run: (context) => catalog.retireUnit(context, { unitId: world.a.product.packUnitId }),
    runAgainstB: (context) => catalog.retireUnit(context, { unitId: world.b.product.packUnitId }),
  },
  // --- Activity log (SPEC §5: "View activity log") ---
  {
    name: "activityLog.listActivity",
    allowed: ["ownerInA", "ADMIN", "MANAGER", "ACCOUNTANT"],
    run: (context) => activityLog.listActivity(context),
  },
  // --- Owner-only: businesses ---
  {
    name: "businesses.listBusinesses",
    allowed: OWNERS,
    run: (context) => businesses.listBusinesses(context),
  },
  {
    name: "businesses.createBusiness",
    allowed: OWNERS,
    run: (context) =>
      businesses.createBusiness(context, {
        name: unique("Business "),
        adminName: "First Admin",
        adminUsername: unique("first.admin"),
        adminPassword: "a-good-password",
      }),
  },
  {
    name: "businesses.renameBusiness",
    allowed: OWNERS,
    run: (context) => businesses.renameBusiness(context, { businessId: world.b.id, name: unique("Renamed ") }),
  },
  {
    name: "businesses.setBusinessActive",
    allowed: OWNERS,
    run: (context) => businesses.setBusinessActive(context, { businessId: world.b.id, active: false }),
  },
  {
    name: "businesses.openBusiness",
    allowed: OWNERS,
    run: (context) => businesses.openBusiness(context, { businessId: world.b.id }),
  },
  {
    name: "businesses.closeBusiness",
    allowed: OWNERS,
    run: (context) => businesses.closeBusiness(context),
  },
  // --- Owner-only: owners ---
  {
    name: "owners.listOwners",
    allowed: OWNERS,
    run: (context) => owners.listOwners(context),
  },
  {
    name: "owners.createOwner",
    allowed: OWNERS,
    run: (context) =>
      owners.createOwner(context, {
        name: "Second Owner",
        username: unique("second.owner"),
        password: "a-good-password",
      }),
  },
  {
    name: "owners.setOwnerDisabled",
    allowed: OWNERS,
    run: async (context) => {
      const other = await createUser({ username: unique("spare.owner"), role: "OWNER", businessId: null });
      return owners.setOwnerDisabled(context, { userId: other.id, disabled: true });
    },
  },
  {
    name: "owners.resetOwnerPassword",
    allowed: OWNERS,
    run: (context) =>
      owners.resetOwnerPassword(context, { userId: world.owner.id, password: "another-password" }),
  },
  {
    name: "system.getSystemCheck",
    allowed: OWNERS,
    run: (context) => system.getSystemCheck(context, { forwardedFor: null, forwardedProto: null }),
  },
  {
    name: "owners.listPlatformActivity",
    allowed: OWNERS,
    run: (context) => owners.listPlatformActivity(context),
  },
];

describe("every server operation is listed here", () => {
  it("has an access test for each exported operation", () => {
    const exported = [
      ...Object.keys(staff).map((name) => `staff.${name}`),
      ...Object.keys(activityLog).map((name) => `activityLog.${name}`),
      ...Object.keys(settings).map((name) => `settings.${name}`),
      ...Object.keys(catalog).map((name) => `catalog.${name}`),
      ...Object.keys(setup).map((name) => `setup.${name}`),
      ...Object.keys(businesses).map((name) => `businesses.${name}`),
      ...Object.keys(owners).map((name) => `owners.${name}`),
      ...Object.keys(system).map((name) => `system.${name}`),
    ].sort();
    expect(OPERATIONS.map((operation) => operation.name).sort()).toEqual(exported);
  });
});

describe("who may call each operation", () => {
  for (const operation of OPERATIONS) {
    for (const actor of ALL_ACTORS) {
      const allowed = operation.allowed.includes(actor);
      it(`${operation.name} — ${actor} is ${allowed ? "allowed" : "refused"}`, async () => {
        const attempt = operation.run(contextOf(actor));
        if (allowed) {
          await expect(attempt).resolves.not.toThrow();
        } else {
          await expect(attempt).rejects.toBeInstanceOf(ForbiddenError);
        }
      });
    }
  }
});

describe("a refused call changes nothing", () => {
  it("leaves the database untouched when a cashier tries to create staff", async () => {
    const before = await getDb().user.count();
    await expect(
      staff.createStaff(world.a.as.CASHIER, {
        name: "Sneaky",
        username: "sneaky",
        password: "a-good-password",
        role: "ADMIN",
      }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    expect(await getDb().user.count()).toBe(before);
  });

  it("leaves the database untouched when an admin tries to create a business", async () => {
    const before = await getDb().business.count();
    await expect(
      businesses.createBusiness(world.a.as.ADMIN, {
        name: "Shadow Business",
        adminName: "X",
        adminUsername: "shadow.admin",
        adminPassword: "a-good-password",
      }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    expect(await getDb().business.count()).toBe(before);
  });
});

/** Everything business B owns, to prove a refused call from business A changed none of it. */
async function snapshotOfB() {
  const db = getDb();
  const where = { businessId: world.b.id };
  return {
    users: await db.user.findMany({ where, orderBy: { id: "asc" }, include: { accounts: true } }),
    products: await db.product.findMany({ where, orderBy: { id: "asc" }, include: { units: { orderBy: { id: "asc" } } } }),
    categories: await db.category.findMany({ where, orderBy: { id: "asc" } }),
    priceChanges: await db.priceChange.count({ where }),
    locations: await db.location.findMany({ where, orderBy: { id: "asc" } }),
    terminals: await db.terminal.findMany({ where, orderBy: { id: "asc" } }),
    business: await db.business.findUnique({ where: { id: world.b.id } }),
  };
}

describe("business A cannot reach business B's records", () => {
  for (const operation of OPERATIONS.filter((op) => op.runAgainstB)) {
    for (const actor of ["ADMIN", "ownerInA"] as Actor[]) {
      it(`${operation.name} — ${actor} of A, using a B record id, gets "not found"`, async () => {
        const before = await snapshotOfB();
        await expect(operation.runAgainstB!(contextOf(actor))).rejects.toBeInstanceOf(NotFoundError);
        expect(await snapshotOfB()).toEqual(before);
      });
    }
  }

  it("lists only A's staff to A's admin", async () => {
    const list = await staff.listStaff(world.a.as.ADMIN);
    expect(list.map((person) => person.username).sort()).toEqual([
      "a.accountant",
      "a.admin",
      "a.cashier",
      "a.manager",
      "a.storekeeper",
    ]);
  });

  it("shows only A's activity to A's admin", async () => {
    await staff.createStaff(world.b.as.ADMIN, {
      name: "B Person",
      username: "b.newperson",
      password: "a-good-password",
      role: "CASHIER",
    });
    const list = (await activityLog.listActivity(world.a.as.ADMIN)).entries;
    expect(list.some((entry) => entry.summary.includes("b.newperson"))).toBe(false);
  });

  it("cannot manage an owner account through the staff operations", async () => {
    await expect(
      staff.setStaffDisabled(world.a.as.ADMIN, { userId: world.owner.id, disabled: true }),
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(
      staff.resetStaffPassword(world.a.as.ADMIN, { userId: world.owner.id, password: "another-password" }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("cannot create an owner through the staff operations", async () => {
    await expect(
      staff.createStaff(world.a.as.ADMIN, {
        name: "Fake Owner",
        username: "fake.owner",
        password: "a-good-password",
        role: "OWNER",
      }),
    ).rejects.toThrow();
    await expect(
      staff.setStaffRole(world.a.as.ADMIN, { userId: world.a.staff.CASHIER.id, role: "OWNER" }),
    ).rejects.toThrow();
    expect(await getDb().user.count({ where: { role: "OWNER" } })).toBe(1);
  });
});
