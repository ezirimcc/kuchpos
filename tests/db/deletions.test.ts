import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { shopToday } from "@/lib/format";
import { addUnit, createProduct, deleteProduct, deleteUnit, getProduct, retireUnit, setUnitPrice } from "@/server/business/catalog";
import { createCustomer, deleteCustomer, getCustomer, setCreditLimit } from "@/server/business/customers";
import { createPaymentMethod, deletePaymentMethod, listPaymentMethods } from "@/server/business/payment-methods";
import { postSale } from "@/server/business/sales";
import { createTerminal, deleteTerminal, getSetup } from "@/server/business/setup";
import { deleteStaff, listStaff } from "@/server/business/staff";
import { receiveGoods } from "@/server/business/stock";
import { createSupplier, deleteSupplier, listSuppliers } from "@/server/business/suppliers";
import { openTill } from "@/server/business/till";
import { getDb } from "@/server/db/client";
import { ForbiddenError, NotFoundError, ValidationError } from "@/server/errors";
import { createWorld, expectBalancesMatchMovements, expectCustomerBalancesMatchEntries, type World } from "../support/world";

/**
 * Deleting records that were never used (C67). The rule everywhere: unused → can be deleted
 * for good, and the activity log says so; used → refused, by the operation in plain words
 * and, behind it, by the database itself.
 */

let world: World;

beforeEach(async () => {
  world = await createWorld();
});

afterEach(async () => {
  await expectBalancesMatchMovements();
  await expectCustomerBalancesMatchEntries();
});

const refused = async (attempt: Promise<unknown>): Promise<string> => {
  try {
    await attempt;
  } catch (error) {
    if (error instanceof ValidationError) return error.message;
    throw error;
  }
  throw new Error("Expected the call to be refused.");
};
const logged = async (action: string) => (await getDb().activityLog.findFirst({ where: { action }, orderBy: { createdAt: "desc" } }))?.summary;

/** Puts 2 packs of the sample product on the Shelf and sells one single for cash, to the customer if given. */
async function tradeTheSampleProduct(customerId?: string) {
  await receiveGoods(world.a.as.STOREKEEPER, {
    requestId: randomUUID(),
    supplierId: world.a.supplierId,
    locationId: world.a.shelfId,
    receivedOn: shopToday(),
    lines: [{ productId: world.a.product.id, unitId: world.a.product.packUnitId, quantity: "2", unitCost: "700" }],
  });
  await openTill(world.a.as.CASHIER, { terminalId: world.a.terminalId, openingFloat: "0" });
  return postSale(world.a.as.CASHIER, {
    requestId: randomUUID(),
    terminalId: world.a.terminalId,
    expectedTotal: "100.00",
    payments: [{ methodId: world.a.cashMethodId, amount: "100.00" }],
    customerId: customerId ?? "",
    lines: [{ productId: world.a.product.id, unitId: world.a.product.baseUnitId, quantity: "1", unitPrice: "100.00" }],
  });
}

describe("a product", () => {
  it("that was never used is deleted with its units and its price history", async () => {
    const admin = world.a.as.ADMIN;
    const { id } = await createProduct(admin, { name: "Typed By Mistake", code: "OOPS-1", barcode: "", baseUnitName: "single", allowsFraction: false, taxable: true, baseForSale: true, basePrice: "500" });
    const pack = await addUnit(admin, { productId: id, name: "pack", factor: "10", forSale: true, forPurchase: true, price: "4500" });
    await setUnitPrice(admin, { unitId: pack.id, price: "4600" });
    const db = getDb();
    expect(await db.priceChange.count({ where: { productId: id } })).toBeGreaterThanOrEqual(3);
    expect((await getProduct(admin, { productId: id })).canDelete).toBe(true);
    // Whoever cannot manage products is not offered it, and cannot do it.
    expect((await getProduct(world.a.as.CASHIER, { productId: id })).canDelete).toBe(false);
    await expect(deleteProduct(world.a.as.CASHIER, { productId: id })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(deleteProduct(world.b.as.ADMIN, { productId: id })).rejects.toBeInstanceOf(NotFoundError);

    await deleteProduct(admin, { productId: id });
    expect(await db.product.count({ where: { id } })).toBe(0);
    expect(await db.productUnit.count({ where: { productId: id } })).toBe(0);
    expect(await db.priceChange.count({ where: { productId: id } })).toBe(0);
    expect(await logged("product.deleted")).toBe('Test a.admin deleted the product "Typed By Mistake" (OOPS-1), which had never been used.');
    await expect(getProduct(admin, { productId: id })).rejects.toBeInstanceOf(NotFoundError);
    // Its code and name are free again.
    await createProduct(admin, { name: "Typed By Mistake", code: "OOPS-1", barcode: "", baseUnitName: "single", allowsFraction: false, taxable: true, baseForSale: true, basePrice: "500" });
    // Price history is still add-only for everything else.
    await expect(db.priceChange.deleteMany({})).rejects.toThrow();
  });

  it("that has been received or sold cannot be deleted — not by the operation, not in the database", async () => {
    await tradeTheSampleProduct();
    expect((await getProduct(world.a.as.ADMIN, { productId: world.a.product.id })).canDelete).toBe(false);
    expect(await refused(deleteProduct(world.a.as.ADMIN, { productId: world.a.product.id }))).toMatch(/has been used.*Take it out of use instead/);
    const db = getDb();
    await expect(db.product.delete({ where: { id: world.a.product.id } })).rejects.toThrow();
    expect(await db.product.count({ where: { id: world.a.product.id } })).toBe(1);
    expect(await db.productUnit.count({ where: { productId: world.a.product.id } })).toBe(2);
  });
});

describe("a unit of a product", () => {
  it("that was never used is deleted with its prices; one that was used can only be retired; the base unit stays", async () => {
    const admin = world.a.as.ADMIN;
    // The sample product has "single" (base) and "pack". A carton is added and never used; a pack is received.
    const carton = await addUnit(admin, { productId: world.a.product.id, name: "carton", factor: "100", forSale: true, forPurchase: true, price: "8500" });
    await tradeTheSampleProduct();
    const db = getDb();
    expect(await db.priceChange.count({ where: { productUnitId: carton.id } })).toBe(1);
    expect((await getProduct(admin, { productId: world.a.product.id })).deletableUnitIds).toEqual([carton.id]);
    expect((await getProduct(world.a.as.CASHIER, { productId: world.a.product.id })).deletableUnitIds).toEqual([]);
    await expect(deleteUnit(world.a.as.CASHIER, { unitId: carton.id })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(deleteUnit(world.b.as.ADMIN, { unitId: carton.id })).rejects.toBeInstanceOf(NotFoundError);

    expect(await refused(deleteUnit(admin, { unitId: world.a.product.packUnitId }))).toMatch(/has been used.*Retire it instead/);
    expect(await refused(deleteUnit(admin, { unitId: world.a.product.baseUnitId }))).toMatch(/base unit cannot be deleted/);
    await expect(db.productUnit.delete({ where: { id: world.a.product.packUnitId } })).rejects.toThrow();

    await deleteUnit(admin, { unitId: carton.id });
    expect(await db.productUnit.count({ where: { id: carton.id } })).toBe(0);
    expect(await db.priceChange.count({ where: { productUnitId: carton.id } })).toBe(0);
    expect(await logged("product.unit_deleted")).toBe('Test a.admin deleted the unit "carton" of "A Seed Sachet", which had never been used.');
    // The used pack is retired instead, and stays on record.
    await retireUnit(admin, { unitId: world.a.product.packUnitId });
    expect((await getProduct(admin, { productId: world.a.product.id })).product.units.map((unit) => [unit.name, unit.retired])).toEqual(expect.arrayContaining([["single", false], ["pack", true]]));
    // A retired unit that was never used can be deleted too, and its name used again.
    const box = await addUnit(admin, { productId: world.a.product.id, name: "box", factor: "20", forSale: false, forPurchase: true, price: "" });
    await retireUnit(admin, { unitId: box.id });
    await deleteUnit(admin, { unitId: box.id });
    await addUnit(admin, { productId: world.a.product.id, name: "carton", factor: "100", forSale: true, forPurchase: true, price: "8500" });
  });
});

describe("a customer", () => {
  it("with no record is deleted, with the history of their credit limit", async () => {
    const { id } = await createCustomer(world.a.as.CASHIER, { name: "Wrong Entry", phone: "08011112222" });
    await setCreditLimit(world.a.as.ADMIN, { customerId: id, creditLimit: "20000" });
    expect((await getCustomer(world.a.as.MANAGER, { customerId: id })).canDelete).toBe(true);
    await expect(deleteCustomer(world.a.as.STOREKEEPER, { customerId: id })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(deleteCustomer(world.b.as.ADMIN, { customerId: id })).rejects.toBeInstanceOf(NotFoundError);

    await deleteCustomer(world.a.as.MANAGER, { customerId: id });
    const db = getDb();
    expect(await db.customer.count({ where: { id } })).toBe(0);
    expect(await db.creditLimitChange.count({ where: { customerId: id } })).toBe(0);
    expect(await logged("customer.deleted")).toBe('Test a.manager deleted the customer "Wrong Entry" (08011112222), who had no records.');
    // The phone number is free again.
    await createCustomer(world.a.as.CASHIER, { name: "Right Entry", phone: "08011112222" });
  });

  it("who has bought anything cannot be deleted", async () => {
    const { id } = await createCustomer(world.a.as.CASHIER, { name: "Real Buyer", phone: "08033334444" });
    await tradeTheSampleProduct(id);
    expect((await getCustomer(world.a.as.MANAGER, { customerId: id })).canDelete).toBe(false);
    expect(await refused(deleteCustomer(world.a.as.MANAGER, { customerId: id }))).toMatch(/they have records.*Take them out of use instead/);
    await expect(getDb().customer.delete({ where: { id } })).rejects.toThrow();
    expect(await getDb().customer.count({ where: { id } })).toBe(1);
  });
});

describe("a staff account", () => {
  it("that only ever signed in is deleted; its sign-ins stay in the activity log under its name", async () => {
    const db = getDb();
    const idle = world.a.staff.ACCOUNTANT;
    // Signed in once and changed their own password: not work.
    await db.activityLog.createMany({
      data: [
        { businessId: world.a.id, actorUserId: idle.id, actorName: "Test a.accountant", actorRole: "ACCOUNTANT", action: "auth.signed_in", summary: "Test a.accountant signed in." },
        { businessId: world.a.id, actorUserId: idle.id, actorName: "Test a.accountant", actorRole: "ACCOUNTANT", action: "account.password_changed", summary: "Test a.accountant changed their own password." },
      ],
    });
    const before = await listStaff(world.a.as.ADMIN);
    expect(before.find((person) => person.id === idle.id)?.canDelete).toBe(true);
    // Never one's own account.
    expect(before.find((person) => person.id === world.a.staff.ADMIN.id)?.canDelete).toBe(false);
    expect(await refused(deleteStaff(world.a.as.ADMIN, { userId: world.a.staff.ADMIN.id }))).toMatch(/cannot delete your own account/);
    await expect(deleteStaff(world.a.as.MANAGER, { userId: idle.id })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(deleteStaff(world.b.as.ADMIN, { userId: idle.id })).rejects.toBeInstanceOf(NotFoundError);

    await deleteStaff(world.a.as.ADMIN, { userId: idle.id });
    expect(await db.user.count({ where: { id: idle.id } })).toBe(0);
    expect(await db.session.count({ where: { userId: idle.id } })).toBe(0);
    expect((await listStaff(world.a.as.ADMIN)).some((person) => person.id === idle.id)).toBe(false);
    // The log lines are all still there, by name; only the link to the account is empty.
    const lines = await db.activityLog.findMany({ where: { actorName: "Test a.accountant" } });
    expect(lines.map((line) => [line.action, line.actorUserId]).sort()).toEqual([["account.password_changed", null], ["auth.signed_in", null]]);
    expect(await logged("staff.deleted")).toBe('Test a.admin deleted the account "a.accountant" (Test a.accountant, Accountant), which had never been used.');
    // The activity log is still add-only for everything else.
    await expect(db.activityLog.deleteMany({})).rejects.toThrow();
  });

  it("that has done any work cannot be deleted", async () => {
    await tradeTheSampleProduct();
    const staff = await listStaff(world.a.as.ADMIN);
    // The storekeeper received goods; the cashier opened a till and sold.
    expect(staff.find((person) => person.id === world.a.staff.STOREKEEPER.id)?.canDelete).toBe(false);
    expect(staff.find((person) => person.id === world.a.staff.CASHIER.id)?.canDelete).toBe(false);
    expect(await refused(deleteStaff(world.a.as.ADMIN, { userId: world.a.staff.CASHIER.id }))).toMatch(/it has been used.*Disable it instead/);
    // Someone whose only trace is a line in the activity log (here: created a supplier) has done work too.
    await createSupplier(world.a.as.MANAGER, { name: "Made By The Manager", phone: "", note: "" });
    expect(await refused(deleteStaff(world.a.as.ADMIN, { userId: world.a.staff.MANAGER.id }))).toMatch(/Disable it instead/);
    expect(await getDb().user.count({ where: { businessId: world.a.id } })).toBe(5);
  });
});

describe("a supplier, a payment method and a checkout terminal", () => {
  it("are deleted when never used", async () => {
    const admin = world.a.as.ADMIN;
    const supplier = await createSupplier(admin, { name: "Never Delivered", phone: "", note: "" });
    const method = await createPaymentMethod(admin, { name: "POS – Unused", kind: "POS" });
    const terminal = await createTerminal(admin, { code: "T2", name: "Second checkout", paperWidth: "MM80" });
    expect((await listSuppliers(admin)).find((row) => row.id === supplier.id)?.canDelete).toBe(true);
    // Someone who only reads deliveries is not offered it.
    expect((await listSuppliers(world.a.as.ACCOUNTANT)).find((row) => row.id === supplier.id)?.canDelete).toBe(false);
    expect((await listPaymentMethods(admin)).map((row) => [row.name, row.canDelete])).toEqual([["Cash", false], ["Bank transfer", true], ["POS – Unused", true]]);
    expect((await getSetup(admin)).terminals.map((row) => [row.code, row.canDelete])).toEqual([["T1", true], ["T2", true]]);
    await expect(deleteSupplier(world.b.as.ADMIN, { supplierId: supplier.id })).rejects.toBeInstanceOf(NotFoundError);
    await expect(deletePaymentMethod(world.a.as.MANAGER, { methodId: method.id })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(deleteTerminal(world.b.as.ADMIN, { terminalId: terminal.id })).rejects.toBeInstanceOf(NotFoundError);

    await deleteSupplier(admin, { supplierId: supplier.id });
    await deletePaymentMethod(admin, { methodId: method.id });
    await deleteTerminal(admin, { terminalId: terminal.id });
    const db = getDb();
    expect(await db.supplier.count({ where: { id: supplier.id } })).toBe(0);
    expect(await db.paymentMethod.count({ where: { id: method.id } })).toBe(0);
    expect(await db.terminal.count({ where: { id: terminal.id } })).toBe(0);
    expect(await logged("supplier.deleted")).toBe('Test a.admin deleted the supplier "Never Delivered", who had no deliveries.');
    expect(await logged("payment_method.deleted")).toBe('Test a.admin deleted the payment method "POS – Unused", which had never been used.');
    expect(await logged("terminal.deleted")).toBe('Test a.admin deleted the terminal "T2" (Second checkout), which had never been used.');
    // The last terminal stays, used or not.
    expect((await getSetup(admin)).terminals.map((row) => [row.code, row.canDelete])).toEqual([["T1", false]]);
    expect(await refused(deleteTerminal(admin, { terminalId: world.a.terminalId }))).toMatch(/only checkout terminal/);
  });

  it("are kept once used, and Cash is always kept", async () => {
    const admin = world.a.as.ADMIN;
    await createTerminal(admin, { code: "T2", name: "Second checkout", paperWidth: "MM80" });
    await tradeTheSampleProduct();
    expect(await refused(deleteSupplier(admin, { supplierId: world.a.supplierId }))).toMatch(/deliveries are recorded from them/);
    expect(await refused(deletePaymentMethod(admin, { methodId: world.a.cashMethodId }))).toMatch(/Cash is always available/);
    expect(await refused(deleteTerminal(admin, { terminalId: world.a.terminalId }))).toMatch(/sales or till sessions were made on it/);
    const db = getDb();
    await expect(db.supplier.delete({ where: { id: world.a.supplierId } })).rejects.toThrow();
    await expect(db.terminal.delete({ where: { id: world.a.terminalId } })).rejects.toThrow();
    // The database keeps Cash even when asked directly, and keeps a method that has taken money.
    await expect(db.paymentMethod.delete({ where: { id: world.b.cashMethodId } })).rejects.toThrow(/Cash payment method cannot be deleted/);
    await expect(db.paymentMethod.delete({ where: { id: world.a.cashMethodId } })).rejects.toThrow();
    expect((await listPaymentMethods(admin)).map((row) => [row.name, row.canDelete])).toEqual([["Cash", false], ["Bank transfer", true]]);
  });
});
