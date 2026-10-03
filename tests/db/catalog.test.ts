import { beforeEach, describe, expect, it } from "vitest";
import { listActivity } from "@/server/business/activity-log";
import {
  addUnit,
  createProduct,
  getProduct,
  listProducts,
  retireUnit,
  setProductActive,
  setUnitPrice,
  setUnitUsage,
  updateProduct,
} from "@/server/business/catalog";
import { getBusinessSettings, setReceiptText, setTaxRate } from "@/server/business/settings";
import { createTerminal, getSetup, renameLocation } from "@/server/business/setup";
import { getDb } from "@/server/db/client";
import { ValidationError } from "@/server/errors";
import { createBusiness } from "@/server/platform/businesses";
import { createWorld, type World } from "../support/world";

let world: World;
beforeEach(async () => {
  world = await createWorld();
});

async function fieldErrorsOf(attempt: Promise<unknown>): Promise<Record<string, string>> {
  try {
    await attempt;
  } catch (error) {
    if (error instanceof ValidationError) return error.fieldErrors;
    throw error;
  }
  throw new Error("Expected the call to be refused.");
}

const sachet = {
  name: "Tomato Seed Sachet",
  code: "TS-01",
  barcode: "",
  baseUnitName: "single",
  allowsFraction: false,
  taxable: true,
  baseForSale: true,
  basePrice: "500",
};

const fertilizer = {
  name: "NPK Fertilizer",
  code: "",
  barcode: "",
  baseUnitName: "kg",
  allowsFraction: true,
  taxable: true,
  baseForSale: true,
  basePrice: "1250.50",
};

describe("a product sold in several units, each with its own price", () => {
  it("holds single = 1, pack = 10, carton = 100 with three unrelated prices", async () => {
    const admin = world.a.as.ADMIN;
    const { id } = await createProduct(admin, sachet);
    await addUnit(admin, { productId: id, name: "pack", factor: "10", forSale: true, forPurchase: true, price: "4500" });
    await addUnit(admin, { productId: id, name: "carton", factor: "100", forSale: true, forPurchase: true, price: "42000" });

    const { product } = await getProduct(admin, { productId: id });
    expect(product.baseUnitName).toBe("single");
    expect(product.units.map((unit) => [unit.name, unit.factor, unit.price])).toEqual([
      ["single", "1.000", "500.00"],
      ["pack", "10.000", "4500.00"],
      ["carton", "100.000", "42000.00"],
    ]);
  });

  it("holds a weighed product: kilogram base, a 50 kg bag, a 0.25 kg sachet", async () => {
    const admin = world.a.as.ADMIN;
    const { id } = await createProduct(admin, fertilizer);
    await addUnit(admin, { productId: id, name: "bag", factor: "50", forSale: true, forPurchase: true, price: "58000" });
    await addUnit(admin, { productId: id, name: "sachet", factor: "0.25", forSale: true, forPurchase: false, price: "350" });

    const { product } = await getProduct(admin, { productId: id });
    expect(product.allowsFraction).toBe(true);
    expect(product.units.map((unit) => [unit.name, unit.factor])).toEqual([
      ["kg", "1.000"],
      ["sachet", "0.250"],
      ["bag", "50.000"],
    ]);
  });

  it("stores ₦1,250.50 exactly, to the kobo", async () => {
    const { id } = await createProduct(world.a.as.ADMIN, fertilizer);
    const unit = await getDb().productUnit.findFirstOrThrow({ where: { productId: id } });
    expect(unit.price?.toFixed(2)).toBe("1250.50");
    expect(unit.price?.toString()).toBe("1250.5");
  });

  it("keeps awkward amounts exact (no drift)", async () => {
    const admin = world.a.as.ADMIN;
    const { id } = await createProduct(admin, { ...fertilizer, basePrice: "0.10" });
    const unitId = (await getProduct(admin, { productId: id })).product.units[0].id;
    for (const price of ["0.30", "1234567.89", "999999999999.99", "0.01"]) {
      await setUnitPrice(admin, { unitId, price });
      expect((await getProduct(admin, { productId: id })).product.units[0].price).toBe(price);
    }
  });

  it("refuses amounts that are not plain numbers, instead of guessing", async () => {
    for (const basePrice of ["1,250", "12.345", "-5", "abc", "1e3", "₦500", " "]) {
      const errors = await fieldErrorsOf(createProduct(world.a.as.ADMIN, { ...sachet, basePrice }));
      expect(errors.basePrice, basePrice).toBeTruthy();
    }
    expect(await getDb().product.count({ where: { name: sachet.name } })).toBe(0);
  });

  it("refuses a conversion that is zero, negative, 1, too precise, or fractional for a whole-unit product", async () => {
    const admin = world.a.as.ADMIN;
    const { id } = await createProduct(admin, sachet);
    for (const factor of ["0", "-10", "1", "2.5", "0.0001", "ten"]) {
      const errors = await fieldErrorsOf(
        addUnit(admin, { productId: id, name: "pack", factor, forSale: true, forPurchase: true, price: "4500" }),
      );
      expect(errors.factor, factor).toBeTruthy();
    }
    expect((await getProduct(admin, { productId: id })).product.units).toHaveLength(1);
  });

  it("saves neither the product nor its unit if anything is wrong", async () => {
    await expect(createProduct(world.a.as.ADMIN, { ...sachet, baseUnitName: "" })).rejects.toBeInstanceOf(ValidationError);
    expect(await getDb().product.count({ where: { name: sachet.name } })).toBe(0);
    expect(await getDb().productUnit.count({ where: { name: "" } })).toBe(0);
  });

  it("allows a base unit that is bought and stocked but not sold on its own", async () => {
    const admin = world.a.as.ADMIN;
    const { id } = await createProduct(admin, { ...fertilizer, baseForSale: false, basePrice: "" });
    const { product } = await getProduct(admin, { productId: id });
    expect(product.units[0]).toMatchObject({ forSale: false, price: null });
  });
});

describe("names, codes and barcodes", () => {
  it("refuses a second product with the same name, code or barcode in the same business", async () => {
    const admin = world.a.as.ADMIN;
    await createProduct(admin, { ...sachet, barcode: "6001234567890" });
    const errors = await fieldErrorsOf(
      createProduct(admin, { ...sachet, name: "tomato seed SACHET", code: "ts-01", barcode: "6001234567890" }),
    );
    expect(Object.keys(errors).sort()).toEqual(["barcode", "code", "name"]);
  });

  it("lets a different business use the same name, code and barcode", async () => {
    await createProduct(world.a.as.ADMIN, { ...sachet, barcode: "6001234567890" });
    await expect(createProduct(world.b.as.ADMIN, { ...sachet, barcode: "6001234567890" })).resolves.toBeTruthy();
  });

  it("creates only one product when the same request arrives twice at once", async () => {
    const results = await Promise.allSettled([
      createProduct(world.a.as.ADMIN, sachet),
      createProduct(world.a.as.ADMIN, sachet),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(await getDb().product.count({ where: { businessId: world.a.id, name: sachet.name } })).toBe(1);
  });

  it("finds products by part of the name, part of the code, or the exact barcode", async () => {
    const admin = world.a.as.ADMIN;
    await createProduct(admin, { ...sachet, barcode: "6001234567890" });
    await createProduct(admin, fertilizer);
    const names = async (search: string) => (await listProducts(admin, { search })).products.map((p) => p.name);
    expect(await names("tomato")).toEqual(["Tomato Seed Sachet"]);
    expect(await names("TS-0")).toEqual(["Tomato Seed Sachet"]);
    expect(await names("6001234567890")).toEqual(["Tomato Seed Sachet"]);
    expect(await names("600123")).toEqual([]);
    expect(await names("")).toHaveLength(3);
  });

  it("changes a product's name, code, barcode and taxable tick, and logs what changed", async () => {
    const admin = world.a.as.ADMIN;
    const { id } = await createProduct(admin, sachet);
    await updateProduct(admin, { productId: id, name: "Tomato Seed (sachet)", code: "TS-01", barcode: "999", taxable: false });
    const { product } = await getProduct(admin, { productId: id });
    expect(product).toMatchObject({ name: "Tomato Seed (sachet)", barcode: "999", taxable: false });
    const [latest] = (await listActivity(admin)).entries;
    expect(latest.summary).toMatch(/marked as not taxable/);
  });
});

describe("changing a price", () => {
  it("records the old price, the new price, who and when", async () => {
    const manager = world.a.as.MANAGER;
    await setUnitPrice(manager, { unitId: world.a.product.packUnitId, price: "950" });
    await setUnitPrice(manager, { unitId: world.a.product.packUnitId, price: "975.50" });

    const { product, priceHistory } = await getProduct(manager, { productId: world.a.product.id });
    expect(product.units.find((unit) => unit.name === "pack")?.price).toBe("975.50");
    expect(priceHistory.map((entry) => [entry.unitName, entry.oldPrice, entry.newPrice, entry.changedByName])).toEqual([
      ["pack", "950.00", "975.50", manager.actor.name],
      ["pack", "900.00", "950.00", manager.actor.name],
    ]);
  });

  it("records the first price of a new product and of a new unit", async () => {
    const admin = world.a.as.ADMIN;
    const { id } = await createProduct(admin, sachet);
    await addUnit(admin, { productId: id, name: "pack", factor: "10", forSale: true, forPurchase: true, price: "4500" });
    const { priceHistory } = await getProduct(admin, { productId: id });
    expect(priceHistory.map((entry) => [entry.unitName, entry.oldPrice, entry.newPrice]).sort()).toEqual([
      ["pack", null, "4500.00"],
      ["single", null, "500.00"],
    ]);
  });

  it("does nothing, and records nothing, when the price is unchanged", async () => {
    const before = await getDb().priceChange.count();
    await setUnitPrice(world.a.as.ADMIN, { unitId: world.a.product.packUnitId, price: "900.00" });
    expect(await getDb().priceChange.count()).toBe(before);
  });

  it("keeps the history straight when two people change the same price at the same moment", async () => {
    const results = await Promise.allSettled([
      setUnitPrice(world.a.as.ADMIN, { unitId: world.a.product.packUnitId, price: "950" }),
      setUnitPrice(world.a.as.MANAGER, { unitId: world.a.product.packUnitId, price: "990" }),
    ]);
    const succeeded = results.filter((result) => result.status === "fulfilled").length;
    const { product, priceHistory } = await getProduct(world.a.as.ADMIN, { productId: world.a.product.id });
    const pack = product.units.find((unit) => unit.name === "pack")!;

    // Every recorded change starts from the price that was really in force, and the last one is the current price.
    expect(priceHistory).toHaveLength(succeeded);
    expect(priceHistory[0].newPrice).toBe(pack.price);
    expect(priceHistory.at(-1)?.oldPrice).toBe("900.00");
    for (const result of results) {
      if (result.status === "rejected") expect(result.reason).toBeInstanceOf(ValidationError);
    }
  });

  it("cannot be done for a unit that is retired or not for sale", async () => {
    const admin = world.a.as.ADMIN;
    await setUnitUsage(admin, { unitId: world.a.product.packUnitId, forSale: false, forPurchase: true, price: "" });
    await expect(setUnitPrice(admin, { unitId: world.a.product.packUnitId, price: "950" })).rejects.toThrow(/not for sale/);
    await retireUnit(admin, { unitId: world.a.product.packUnitId });
    await expect(setUnitPrice(admin, { unitId: world.a.product.packUnitId, price: "950" })).rejects.toThrow(/retired/);
  });

  it("is refused by the database itself if the history is tampered with", async () => {
    await setUnitPrice(world.a.as.ADMIN, { unitId: world.a.product.packUnitId, price: "950" });
    const entry = await getDb().priceChange.findFirstOrThrow();
    await expect(getDb().priceChange.update({ where: { id: entry.id }, data: { newPrice: "1" } })).rejects.toThrow();
    await expect(getDb().priceChange.delete({ where: { id: entry.id } })).rejects.toThrow();
  });
});

describe("units keep their meaning", () => {
  it("retires a unit instead of changing its conversion, and lets a new unit reuse the name", async () => {
    const admin = world.a.as.ADMIN;
    await retireUnit(admin, { unitId: world.a.product.packUnitId });
    await addUnit(admin, { productId: world.a.product.id, name: "pack", factor: "12", forSale: true, forPurchase: true, price: "1050" });

    const { product } = await getProduct(admin, { productId: world.a.product.id });
    const packs = product.units.filter((unit) => unit.name === "pack");
    expect(packs.map((unit) => [unit.factor, unit.retired]).sort()).toEqual([
      ["10.000", true],
      ["12.000", false],
    ]);
    // The retired unit still exists with its original conversion, for any record that used it.
    const original = await getDb().productUnit.findUniqueOrThrow({ where: { id: world.a.product.packUnitId } });
    expect(original.factor.toFixed(3)).toBe("10.000");
  });

  it("refuses two in-use units with the same name, even when sent at the same moment", async () => {
    const admin = world.a.as.ADMIN;
    const carton = { productId: world.a.product.id, name: "Carton", factor: "100", forSale: true, forPurchase: true, price: "8500" };
    const results = await Promise.allSettled([addUnit(admin, carton), addUnit(admin, { ...carton, name: "carton" })]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const errors = await fieldErrorsOf(addUnit(admin, carton));
    expect(errors.name).toMatch(/already has a unit/);
  });

  it("offers no way to edit a unit's name or conversion", async () => {
    const catalog = await import("@/server/business/catalog");
    expect(Object.keys(catalog).filter((name) => /unit/i.test(name)).sort()).toEqual([
      "addUnit",
      "retireUnit",
      "setUnitPrice",
      "setUnitUsage",
    ]);
  });

  it("never retires the base unit", async () => {
    await expect(retireUnit(world.a.as.ADMIN, { unitId: world.a.product.baseUnitId })).rejects.toThrow(/base unit/);
  });

  it("needs a price before a unit can be marked for sale", async () => {
    const admin = world.a.as.ADMIN;
    const { id } = await addUnit(admin, { productId: world.a.product.id, name: "carton", factor: "100", forSale: false, forPurchase: true, price: "" });
    const errors = await fieldErrorsOf(setUnitUsage(admin, { unitId: id, forSale: true, forPurchase: true, price: "" }));
    expect(errors.price).toBeTruthy();
    await setUnitUsage(admin, { unitId: id, forSale: true, forPurchase: true, price: "8500" });
    const { product } = await getProduct(admin, { productId: world.a.product.id });
    expect(product.units.find((unit) => unit.name === "carton")).toMatchObject({ forSale: true, price: "8500.00" });
  });

  it("is refused by the database itself for a zero conversion, a negative price, or a for-sale unit with no price", async () => {
    const id = world.a.product.packUnitId;
    await expect(getDb().productUnit.update({ where: { id }, data: { factor: "0" } })).rejects.toThrow();
    await expect(getDb().productUnit.update({ where: { id }, data: { price: "-1" } })).rejects.toThrow();
    await expect(getDb().productUnit.update({ where: { id }, data: { price: null } })).rejects.toThrow();
    await expect(
      getDb().productUnit.update({ where: { id: world.a.product.baseUnitId }, data: { factor: "2" } }),
    ).rejects.toThrow();
  });
});

describe("taking a product out of use", () => {
  it("hides it from the normal list but never deletes it", async () => {
    const admin = world.a.as.ADMIN;
    await setProductActive(admin, { productId: world.a.product.id, active: false });
    expect((await listProducts(admin)).products).toHaveLength(0);
    expect((await listProducts(admin, { includeInactive: true })).products).toHaveLength(1);
    expect(await getDb().product.count({ where: { id: world.a.product.id } })).toBe(1);

    await setProductActive(admin, { productId: world.a.product.id, active: true });
    expect((await listProducts(admin)).products).toHaveLength(1);
  });
});

describe("each business has its own catalogue", () => {
  it("shows a product created in business A only in business A", async () => {
    await createProduct(world.a.as.ADMIN, sachet);
    const inA = (await listProducts(world.a.as.CASHIER)).products.map((product) => product.name);
    const inB = (await listProducts(world.b.as.CASHIER)).products.map((product) => product.name);
    expect(inA).toContain("Tomato Seed Sachet");
    expect(inB).not.toContain("Tomato Seed Sachet");
    expect(inB).toEqual(["B Seed Sachet"]);
  });
});

describe("tax rate", () => {
  it("starts at 0% for every business", async () => {
    expect((await getBusinessSettings(world.a.as.ADMIN)).taxRatePercent).toBe("0.00");
  });

  it("is changed by the admin, recorded with who and when, and separate per business", async () => {
    await setTaxRate(world.a.as.ADMIN, { ratePercent: "7.5" });
    const a = await getBusinessSettings(world.a.as.ADMIN);
    expect(a.taxRatePercent).toBe("7.50");
    expect(a.taxRateHistory.map((entry) => [entry.oldRatePercent, entry.newRatePercent, entry.changedByName])).toEqual([
      ["0.00", "7.50", world.a.as.ADMIN.actor.name],
    ]);
    expect((await getBusinessSettings(world.b.as.ADMIN)).taxRatePercent).toBe("0.00");
    expect((await listActivity(world.a.as.ADMIN)).entries[0].summary).toMatch(/from 0.00% to 7.50%/);
  });

  it("refuses rates below 0, above 100, or not a number", async () => {
    for (const ratePercent of ["-1", "100.01", "seven", "7.555", ""]) {
      await expect(setTaxRate(world.a.as.ADMIN, { ratePercent }), ratePercent).rejects.toBeInstanceOf(ValidationError);
    }
    await expect(
      getDb().business.update({ where: { id: world.a.id }, data: { taxRatePercent: "101" } }),
    ).rejects.toThrow();
  });

  it("keeps its history untouchable", async () => {
    await setTaxRate(world.a.as.ADMIN, { ratePercent: "7.5" });
    const entry = await getDb().taxRateChange.findFirstOrThrow();
    await expect(getDb().taxRateChange.update({ where: { id: entry.id }, data: { newRatePercent: "0" } })).rejects.toThrow();
    await expect(getDb().taxRateChange.delete({ where: { id: entry.id } })).rejects.toThrow();
  });
});

describe("business setup", () => {
  it("gives a new business a Shelf, a Storeroom and one terminal", async () => {
    const { id } = await createBusiness(world.ownerOutside, {
      name: "Fresh Start Agro",
      adminName: "First Admin",
      adminUsername: "fresh.admin",
      adminPassword: "a-good-password",
    });
    const locations = await getDb().location.findMany({ where: { businessId: id }, orderBy: { kind: "asc" } });
    const terminals = await getDb().terminal.findMany({ where: { businessId: id } });
    expect(locations.map((location) => [location.name, location.kind])).toEqual([
      ["Shelf", "SHELF"],
      ["Storeroom", "STOREROOM"],
    ]);
    expect(terminals.map((terminal) => [terminal.code, terminal.paperWidth])).toEqual([["T1", "MM80"]]);
  });

  it("adds a terminal with its own code and paper width; codes are unique within a business only", async () => {
    await createTerminal(world.a.as.ADMIN, { code: "t2", name: "Back till", paperWidth: "MM58" });
    const { terminals } = await getSetup(world.a.as.ADMIN);
    expect(terminals.map((terminal) => [terminal.code, terminal.paperWidth])).toEqual([
      ["T1", "MM80"],
      ["T2", "MM58"],
    ]);
    const errors = await fieldErrorsOf(createTerminal(world.a.as.ADMIN, { code: "T2", name: "Again", paperWidth: "MM80" }));
    expect(errors.code).toMatch(/already has a terminal/);
    await expect(createTerminal(world.b.as.ADMIN, { code: "T2", name: "Other shop", paperWidth: "MM80" })).resolves.toBeTruthy();
  });

  it("refuses a terminal code that is not 1–6 letters or digits", async () => {
    for (const code of ["", "TOOLONG7", "T 1", "T-1"]) {
      await expect(createTerminal(world.a.as.ADMIN, { code, name: "X till", paperWidth: "MM80" }), code).rejects.toBeInstanceOf(ValidationError);
    }
  });

  it("renames a location and stores receipt text", async () => {
    await renameLocation(world.a.as.ADMIN, { locationId: world.a.shelfId, name: "Shop floor" });
    expect((await getSetup(world.a.as.ADMIN)).locations.map((location) => location.name)).toContain("Shop floor");

    await setReceiptText(world.a.as.ADMIN, { header: "12 Market Road\n0800 000 0000", footer: "Thank you!" });
    const settings = await getBusinessSettings(world.a.as.ADMIN);
    expect(settings.receiptHeader).toBe("12 Market Road\n0800 000 0000");
    expect(settings.receiptFooter).toBe("Thank you!");
    expect((await getBusinessSettings(world.b.as.ADMIN)).receiptHeader).toBe("");
  });
});

describe("categories", () => {
  it("are created, renamed and listed with their product counts, per business", async () => {
    const admin = world.a.as.ADMIN;
    const catalog = await import("@/server/business/catalog");
    const { id } = await catalog.createCategory(admin, { name: "Fertilizers" });
    await catalog.renameCategory(admin, { categoryId: id, name: "Fertilisers" });

    expect((await catalog.listCategories(admin)).map((c) => [c.name, c.productCount])).toEqual([
      ["Empty", 0],
      ["Fertilisers", 0],
      ["Seeds", 1],
    ]);
    // Business B has its own list, untouched.
    expect((await catalog.listCategories(world.b.as.ADMIN)).map((c) => c.name)).toEqual(["Empty", "Seeds"]);
  });

  it("refuses two categories with the same name in one business, but allows it across businesses", async () => {
    const catalog = await import("@/server/business/catalog");
    const errors = await fieldErrorsOf(catalog.createCategory(world.a.as.ADMIN, { name: "seeds" }));
    expect(errors.name).toMatch(/already a category/);
    await expect(catalog.createCategory(world.b.as.ADMIN, { name: "Tools" })).resolves.toBeTruthy();
    await expect(catalog.createCategory(world.a.as.ADMIN, { name: "Tools" })).resolves.toBeTruthy();
  });

  it("removes an empty category, but not one that still has products", async () => {
    const catalog = await import("@/server/business/catalog");
    await catalog.removeCategory(world.a.as.ADMIN, { categoryId: world.a.emptyCategoryId });
    await expect(catalog.removeCategory(world.a.as.ADMIN, { categoryId: world.a.categoryId })).rejects.toThrow(
      /still has 1 product/,
    );
    expect((await catalog.listCategories(world.a.as.ADMIN)).map((c) => c.name)).toEqual(["Seeds"]);
    // The database itself also refuses to drop a category a product points at.
    await expect(getDb().category.delete({ where: { id: world.a.categoryId } })).rejects.toThrow();
  });

  it("puts a product in a category, moves it, and takes it out again", async () => {
    const admin = world.a.as.ADMIN;
    const { id } = await createProduct(admin, { ...sachet, categoryId: world.a.categoryId });
    expect((await getProduct(admin, { productId: id })).product.category?.name).toBe("Seeds");

    const details = { productId: id, name: sachet.name, code: sachet.code, barcode: "", taxable: true };
    await updateProduct(admin, { ...details, categoryId: world.a.emptyCategoryId });
    expect((await getProduct(admin, { productId: id })).product.category?.name).toBe("Empty");
    expect((await listActivity(admin)).entries[0].summary).toMatch(/category to "Empty"/);

    await updateProduct(admin, { ...details, categoryId: "" });
    expect((await getProduct(admin, { productId: id })).product.category).toBeNull();
  });

  it("refuses to put a product into another business's category", async () => {
    const errors = await fieldErrorsOf(createProduct(world.a.as.ADMIN, { ...sachet, categoryId: world.b.categoryId }));
    expect(errors.categoryId).toBeTruthy();
    const errorsOnUpdate = await fieldErrorsOf(
      updateProduct(world.a.as.ADMIN, {
        productId: world.a.product.id,
        name: "A Seed Sachet",
        code: "A-001",
        barcode: "",
        taxable: true,
        categoryId: world.b.categoryId,
      }),
    );
    expect(errorsOnUpdate.categoryId).toBeTruthy();
    expect((await getDb().product.findUniqueOrThrow({ where: { id: world.a.product.id } })).categoryId).toBe(
      world.a.categoryId,
    );
  });

  it("filters the product list by category, and by 'no category'", async () => {
    const admin = world.a.as.ADMIN;
    await createProduct(admin, sachet);
    await createProduct(admin, { ...fertilizer, categoryId: world.a.emptyCategoryId });
    const names = async (category: string) => (await listProducts(admin, { category })).products.map((p) => p.name);
    expect(await names(world.a.categoryId)).toEqual(["A Seed Sachet"]);
    expect(await names(world.a.emptyCategoryId)).toEqual(["NPK Fertilizer"]);
    expect(await names("none")).toEqual(["Tomato Seed Sachet"]);
    expect(await names("")).toHaveLength(3);
    // Another business's category id simply matches nothing.
    expect(await names(world.b.categoryId)).toEqual([]);
  });
});

describe("a product's name can be changed at any time", () => {
  it("renames a product and keeps its units, prices and history", async () => {
    const admin = world.a.as.ADMIN;
    await setUnitPrice(admin, { unitId: world.a.product.packUnitId, price: "950" });
    await updateProduct(admin, {
      productId: world.a.product.id,
      name: "Premium Seed Sachet",
      code: "A-001",
      barcode: "",
      categoryId: world.a.categoryId,
      taxable: true,
    });
    const { product, priceHistory } = await getProduct(admin, { productId: world.a.product.id });
    expect(product.name).toBe("Premium Seed Sachet");
    expect(product.units.map((unit) => unit.name)).toEqual(["single", "pack"]);
    expect(priceHistory).toHaveLength(1);
  });
});

describe("long lists come a page at a time", () => {
  it("returns 50 products per page with the total, in name order, without repeats or gaps", async () => {
    const rows = Array.from({ length: 120 }, (_, index) => ({
      businessId: world.a.id,
      name: `Bulk Product ${String(index + 1).padStart(3, "0")}`,
      allowsFraction: false,
    }));
    await getDb().product.createMany({ data: rows });

    const admin = world.a.as.ADMIN;
    const first = await listProducts(admin, { search: "Bulk" });
    expect(first).toMatchObject({ total: 120, page: 1, pageCount: 3, pageSize: 50 });
    const second = await listProducts(admin, { search: "Bulk", page: 2 });
    const third = await listProducts(admin, { search: "Bulk", page: "3" });
    const all = [...first.products, ...second.products, ...third.products].map((product) => product.name);
    expect(all).toHaveLength(120);
    expect(new Set(all).size).toBe(120);
    expect(all).toEqual([...all].sort());
    expect(third.products).toHaveLength(20);

    // A page past the end is simply empty; nonsense page numbers fall back to page 1.
    expect((await listProducts(admin, { search: "Bulk", page: 9 })).products).toEqual([]);
    expect((await listProducts(admin, { search: "Bulk", page: "abc" })).page).toBe(1);
    expect((await listProducts(admin, { search: "Bulk", page: -3 })).page).toBe(1);
  });

  it("pages the activity log and filters it by words and by shop-time date range", async () => {
    const db = getDb();
    const at = (iso: string, summary: string, actorName = "Ada Admin") => ({
      businessId: world.a.id,
      actorName,
      action: "test.event",
      summary,
      createdAt: new Date(iso),
    });
    await db.activityLog.createMany({
      data: [
        // 23:30 UTC on 9 March is already 00:30 on 10 March in Nigeria.
        at("2026-03-09T23:30:00.000Z", "Late-night stock count of maize"),
        at("2026-03-10T12:00:00.000Z", "Changed the price of maize per bag"),
        at("2026-03-10T22:59:59.000Z", "Evening sale of fertilizer", "Musa Manager"),
        // 23:00 UTC on 10 March is 00:00 on 11 March in Nigeria.
        at("2026-03-10T23:00:00.000Z", "First entry of the next day"),
        ...Array.from({ length: 60 }, (_, index) => at(`2026-02-01T10:${String(index).padStart(2, "0")}:00.000Z`, `Filler ${index}`)),
      ],
    });
    const admin = world.a.as.ADMIN;

    const day = await listActivity(admin, { from: "2026-03-10", to: "2026-03-10" });
    expect(day.entries.map((entry) => entry.summary)).toEqual([
      "Evening sale of fertilizer",
      "Changed the price of maize per bag",
      "Late-night stock count of maize",
    ]);

    expect((await listActivity(admin, { search: "maize" })).total).toBe(2);
    expect((await listActivity(admin, { search: "musa" })).entries.map((entry) => entry.summary)).toEqual([
      "Evening sale of fertilizer",
    ]);
    expect((await listActivity(admin, { search: "maize", from: "2026-03-10", to: "2026-03-10" })).total).toBe(2);
    expect((await listActivity(admin, { from: "2026-03-11" })).entries.map((entry) => entry.summary)).toContain(
      "First entry of the next day",
    );

    const february = await listActivity(admin, { from: "2026-02-01", to: "2026-02-01" });
    expect(february).toMatchObject({ total: 60, pageCount: 2 });
    expect(february.entries).toHaveLength(50);
    expect((await listActivity(admin, { from: "2026-02-01", to: "2026-02-01", page: 2 })).entries).toHaveLength(10);

    // Bad dates are ignored rather than causing an error.
    await expect(listActivity(admin, { from: "not-a-date", to: "2026-13-45" })).resolves.toBeTruthy();
    // Business B sees none of it.
    expect((await listActivity(world.b.as.ADMIN, { search: "maize" })).total).toBe(0);
  });
});
