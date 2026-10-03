import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { addMonths, shopToday } from "@/lib/format";
import { listActivity } from "@/server/business/activity-log";
import { addUnit, createProduct, retireUnit, updateProduct } from "@/server/business/catalog";
import { getBusinessSettings, setExpiringSoonMonths } from "@/server/business/settings";
import {
  getReceipt,
  getReceivingOptions,
  listExpiringSoon,
  listReceipts,
  listStockOnHand,
  receiveGoods,
} from "@/server/business/stock";
import { createSupplier, listSuppliers, setSupplierActive, updateSupplier } from "@/server/business/suppliers";
import { getDb } from "@/server/db/client";
import { ValidationError } from "@/server/errors";
import { createWorld, expectBalancesMatchMovements, type World } from "../support/world";

let world: World;
beforeEach(async () => {
  world = await createWorld();
});

// The golden rule, checked after every single test in this file.
afterEach(async () => {
  await expectBalancesMatchMovements();
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

type Line = { productId: string; unitId: string; quantity: string; unitCost: string; batchNumber?: string; expiryDate?: string };

function delivery(lines: Line[], extra: Record<string, unknown> = {}) {
  return {
    requestId: randomUUID(),
    supplierId: world.a.supplierId,
    locationId: world.a.storeroomId,
    lines,
    ...extra,
  };
}

async function quantityAt(productId: string, locationId: string): Promise<string> {
  const balance = await getDb().stockBalance.findUnique({ where: { productId_locationId: { productId, locationId } } });
  return balance ? balance.quantity.toFixed(3) : "0.000";
}

async function averageCost(productId: string): Promise<string> {
  return (await getDb().product.findUniqueOrThrow({ where: { id: productId } })).averageCost.toFixed(4);
}

/** A whole-unit product with single = 1, pack = 10 (from the fixtures) and carton = 100. */
async function withCarton() {
  const { id } = await addUnit(world.a.as.ADMIN, {
    productId: world.a.product.id,
    name: "carton",
    factor: "100",
    forSale: true,
    forPurchase: true,
    price: "8500",
  });
  return { productId: world.a.product.id, cartonId: id, packId: world.a.product.packUnitId, singleId: world.a.product.baseUnitId };
}

/** A weighed product in kg with a 50 kg bag, set up to need a batch number and an expiry date. */
async function fertilizer(flags: { tracksBatch?: boolean; tracksExpiry?: boolean } = {}) {
  const admin = world.a.as.ADMIN;
  const { id } = await createProduct(admin, {
    name: "NPK Fertilizer",
    code: "",
    barcode: "",
    baseUnitName: "kg",
    allowsFraction: true,
    taxable: true,
    tracksBatch: flags.tracksBatch ?? false,
    tracksExpiry: flags.tracksExpiry ?? false,
    baseForSale: true,
    basePrice: "1250.50",
  });
  const bag = await addUnit(admin, { productId: id, name: "bag", factor: "50", forSale: true, forPurchase: true, price: "58000" });
  const kg = await getDb().productUnit.findFirstOrThrow({ where: { productId: id, isBase: true } });
  return { productId: id, bagId: bag.id, kgId: kg.id };
}

describe("receiving goods", () => {
  it("puts 2 cartons of 100 into the Storeroom as 200 singles, and nothing on the Shelf", async () => {
    const product = await withCarton();
    await receiveGoods(world.a.as.STOREKEEPER, delivery([{ productId: product.productId, unitId: product.cartonId, quantity: "2", unitCost: "30000" }]));

    expect(await quantityAt(product.productId, world.a.storeroomId)).toBe("200.000");
    expect(await quantityAt(product.productId, world.a.shelfId)).toBe("0.000");
  });

  it("turns 3 bags of 50 kg into 150.000 kg", async () => {
    const product = await fertilizer();
    await receiveGoods(world.a.as.STOREKEEPER, delivery([{ productId: product.productId, unitId: product.bagId, quantity: "3", unitCost: "40000" }]));
    expect(await quantityAt(product.productId, world.a.storeroomId)).toBe("150.000");
  });

  it("accepts fractions of a weighed product (2.5 kg) but not of a whole-unit product", async () => {
    const weighed = await fertilizer();
    await receiveGoods(world.a.as.ADMIN, delivery([{ productId: weighed.productId, unitId: weighed.kgId, quantity: "2.5", unitCost: "800" }]));
    expect(await quantityAt(weighed.productId, world.a.storeroomId)).toBe("2.500");

    const errors = await fieldErrorsOf(
      receiveGoods(world.a.as.ADMIN, delivery([{ productId: world.a.product.id, unitId: world.a.product.packUnitId, quantity: "2.5", unitCost: "700" }])),
    );
    expect(errors["lines.0.quantity"]).toMatch(/whole units only/);
  });

  it("adds several lines of the same product together, and goes to the chosen location", async () => {
    const product = await withCarton();
    await receiveGoods(
      world.a.as.ADMIN,
      delivery(
        [
          { productId: product.productId, unitId: product.cartonId, quantity: "1", unitCost: "30000" },
          { productId: product.productId, unitId: product.packId, quantity: "3", unitCost: "3200" },
          { productId: product.productId, unitId: product.singleId, quantity: "7", unitCost: "330" },
        ],
        { locationId: world.a.shelfId },
      ),
    );
    expect(await quantityAt(product.productId, world.a.shelfId)).toBe("137.000");
    expect(await quantityAt(product.productId, world.a.storeroomId)).toBe("0.000");
  });

  it("records one movement per line, with the unit and conversion as they were", async () => {
    const product = await withCarton();
    const { id, number } = await receiveGoods(
      world.a.as.STOREKEEPER,
      delivery([{ productId: product.productId, unitId: product.cartonId, quantity: "2", unitCost: "30000" }]),
    );
    const movements = await getDb().stockMovement.findMany({ where: { documentId: id } });
    expect(movements).toHaveLength(1);
    expect(movements[0]).toMatchObject({
      type: "RECEIPT",
      unitName: "carton",
      documentType: "goods_receipt",
      documentNumber: `GR-${String(number).padStart(6, "0")}`,
      userName: world.a.as.STOREKEEPER.actor.name,
      locationId: world.a.storeroomId,
    });
    expect(movements[0].quantityDelta.toFixed(3)).toBe("200.000");
    expect(movements[0].unitFactor.toFixed(3)).toBe("100.000");
    expect(movements[0].unitQuantity.toFixed(3)).toBe("2.000");
  });

  it("stores the money exactly: quantity × cost per line, rounded to the kobo, and the sum as the total", async () => {
    const weighed = await fertilizer();
    const { id } = await receiveGoods(
      world.a.as.ADMIN,
      delivery([
        { productId: weighed.productId, unitId: weighed.kgId, quantity: "2.375", unitCost: "1333" }, // 3165.875 → 3165.88
        { productId: weighed.productId, unitId: weighed.bagId, quantity: "1", unitCost: "40000.10" },
      ]),
    );
    const receipt = await getReceipt(world.a.as.ADMIN, { receiptId: id });
    expect(receipt.lines.map((line) => line.lineCost)).toEqual(["3165.88", "40000.10"]);
    expect(receipt.totalCost).toBe("43165.98");
  });

  it("numbers deliveries 1, 2, 3… separately for each business", async () => {
    const line = [{ productId: world.a.product.id, unitId: world.a.product.packUnitId, quantity: "1", unitCost: "700" }];
    const first = await receiveGoods(world.a.as.ADMIN, delivery(line));
    const second = await receiveGoods(world.a.as.ADMIN, delivery(line));
    const inB = await receiveGoods(world.b.as.ADMIN, {
      requestId: randomUUID(),
      supplierId: world.b.supplierId,
      locationId: world.b.storeroomId,
      lines: [{ productId: world.b.product.id, unitId: world.b.product.packUnitId, quantity: "1", unitCost: "700" }],
    });
    expect([first.number, second.number, inB.number]).toEqual([1, 2, 1]);
  });
});

describe("the same delivery is never saved twice", () => {
  const line = () => [{ productId: world.a.product.id, unitId: world.a.product.packUnitId, quantity: "2", unitCost: "700" }];

  it("returns the first result when the same request is sent again", async () => {
    const request = delivery(line());
    const first = await receiveGoods(world.a.as.ADMIN, request);
    const again = await receiveGoods(world.a.as.ADMIN, request);

    expect(first.alreadySaved).toBe(false);
    expect(again).toEqual({ id: first.id, number: first.number, alreadySaved: true });
    expect(await getDb().goodsReceipt.count({ where: { businessId: world.a.id } })).toBe(1);
    expect(await quantityAt(world.a.product.id, world.a.storeroomId)).toBe("20.000");
  });

  it("saves it once when the same request arrives twice at the same instant", async () => {
    const request = delivery(line());
    const results = await Promise.all([receiveGoods(world.a.as.ADMIN, request), receiveGoods(world.a.as.ADMIN, request)]);

    expect(new Set(results.map((result) => result.id)).size).toBe(1);
    expect(await getDb().goodsReceipt.count({ where: { businessId: world.a.id } })).toBe(1);
    expect(await getDb().stockMovement.count({ where: { businessId: world.a.id } })).toBe(1);
    expect(await quantityAt(world.a.product.id, world.a.storeroomId)).toBe("20.000");
  });

  it("refuses a request without a proper id", async () => {
    await expect(receiveGoods(world.a.as.ADMIN, { ...delivery(line()), requestId: "not-an-id" })).rejects.toBeInstanceOf(ValidationError);
  });
});

describe("all or nothing", () => {
  it("saves nothing at all when one line is wrong", async () => {
    const before = {
      receipts: await getDb().goodsReceipt.count(),
      lines: await getDb().goodsReceiptLine.count(),
      movements: await getDb().stockMovement.count(),
      balances: await getDb().stockBalance.count(),
      log: await getDb().activityLog.count(),
    };
    const errors = await fieldErrorsOf(
      receiveGoods(
        world.a.as.ADMIN,
        delivery([
          { productId: world.a.product.id, unitId: world.a.product.packUnitId, quantity: "5", unitCost: "700" },
          { productId: world.a.product.id, unitId: world.a.product.packUnitId, quantity: "0", unitCost: "700" },
          { productId: world.a.product.id, unitId: world.a.product.packUnitId, quantity: "1", unitCost: "7,00" },
        ]),
      ),
    );
    expect(Object.keys(errors).sort()).toEqual(["lines.1.quantity", "lines.2.unitCost"]);
    expect({
      receipts: await getDb().goodsReceipt.count(),
      lines: await getDb().goodsReceiptLine.count(),
      movements: await getDb().stockMovement.count(),
      balances: await getDb().stockBalance.count(),
      log: await getDb().activityLog.count(),
    }).toEqual(before);
    expect(await averageCost(world.a.product.id)).toBe("0.0000");
  });

  it("refuses an empty delivery, a missing supplier, and amounts that are not plain numbers", async () => {
    await expect(receiveGoods(world.a.as.ADMIN, delivery([]))).rejects.toBeInstanceOf(ValidationError);
    for (const bad of [
      { quantity: "-1", unitCost: "700" },
      { quantity: "abc", unitCost: "700" },
      { quantity: "1.2345", unitCost: "700" },
      { quantity: "1", unitCost: "-5" },
      { quantity: "1", unitCost: "12.345" },
      { quantity: "1", unitCost: "" },
    ]) {
      await expect(
        receiveGoods(world.a.as.ADMIN, delivery([{ productId: world.a.product.id, unitId: world.a.product.packUnitId, ...bad }])),
        JSON.stringify(bad),
      ).rejects.toBeInstanceOf(ValidationError);
    }
    const errors = await fieldErrorsOf(
      receiveGoods(world.a.as.ADMIN, {
        ...delivery([{ productId: world.a.product.id, unitId: world.a.product.packUnitId, quantity: "1", unitCost: "700" }]),
        supplierId: randomUUID(),
      }),
    );
    expect(errors.supplierId).toBeTruthy();
    expect(await getDb().goodsReceipt.count()).toBe(0);
  });

  it("refuses a product or unit that is out of use, retired, or not for buying", async () => {
    const product = await withCarton();
    await retireUnit(world.a.as.ADMIN, { unitId: product.cartonId });
    const errors = await fieldErrorsOf(
      receiveGoods(world.a.as.ADMIN, delivery([{ productId: product.productId, unitId: product.cartonId, quantity: "1", unitCost: "30000" }])),
    );
    expect(errors["lines.0.unitId"]).toBeTruthy();

    // A unit of a different product is not accepted either.
    const other = await fertilizer();
    const mixed = await fieldErrorsOf(
      receiveGoods(world.a.as.ADMIN, delivery([{ productId: product.productId, unitId: other.bagId, quantity: "1", unitCost: "30000" }])),
    );
    expect(mixed["lines.0.unitId"]).toBeTruthy();
  });
});

describe("average cost", () => {
  it("is exactly ₦60.00 after 100 at ₦50 and then 100 at ₦70", async () => {
    const id = world.a.product.id;
    const single = world.a.product.baseUnitId;
    await receiveGoods(world.a.as.ADMIN, delivery([{ productId: id, unitId: single, quantity: "100", unitCost: "50" }]));
    expect(await averageCost(id)).toBe("50.0000");
    await receiveGoods(world.a.as.ADMIN, delivery([{ productId: id, unitId: single, quantity: "100", unitCost: "70" }]));
    expect(await averageCost(id)).toBe("60.0000");
  });

  it("is worked out per base unit whatever unit the goods arrived in, across both locations", async () => {
    const product = await withCarton();
    // 2 cartons (200 singles) for 60,000 → 300 each, into the Storeroom.
    await receiveGoods(world.a.as.ADMIN, delivery([{ productId: product.productId, unitId: product.cartonId, quantity: "2", unitCost: "30000" }]));
    expect(await averageCost(product.productId)).toBe("300.0000");
    // 10 packs (100 singles) for 36,000 → 360 each, onto the Shelf. (200×300 + 36,000) ÷ 300 = 320.
    await receiveGoods(
      world.a.as.ADMIN,
      delivery([{ productId: product.productId, unitId: product.packId, quantity: "10", unitCost: "3600" }], { locationId: world.a.shelfId }),
    );
    expect(await averageCost(product.productId)).toBe("320.0000");
  });

  it("counts two deliveries of one product that are saved at the same instant", async () => {
    const id = world.a.product.id;
    const single = world.a.product.baseUnitId;
    const results = await Promise.all([
      receiveGoods(world.a.as.ADMIN, delivery([{ productId: id, unitId: single, quantity: "100", unitCost: "50" }])),
      receiveGoods(world.a.as.MANAGER, delivery([{ productId: id, unitId: single, quantity: "100", unitCost: "70" }])),
      receiveGoods(world.a.as.STOREKEEPER, delivery([{ productId: id, unitId: single, quantity: "100", unitCost: "90" }], { locationId: world.a.shelfId })),
    ]);

    expect(results.map((result) => result.number).sort()).toEqual([1, 2, 3]);
    expect(await quantityAt(id, world.a.storeroomId)).toBe("200.000");
    expect(await quantityAt(id, world.a.shelfId)).toBe("100.000");
    // Whatever order they landed in, the average of 100@50, 100@70, 100@90 is 70.
    expect(await averageCost(id)).toBe("70.0000");
    expect(await getDb().stockMovement.count({ where: { productId: id } })).toBe(3);
  });

  it("is kept separately for each business", async () => {
    await receiveGoods(world.a.as.ADMIN, delivery([{ productId: world.a.product.id, unitId: world.a.product.baseUnitId, quantity: "10", unitCost: "50" }]));
    expect(await averageCost(world.b.product.id)).toBe("0.0000");
  });
});

describe("batch numbers and expiry dates", () => {
  const future = addMonths(shopToday(), 2);

  it("are required on a product set up to use them", async () => {
    const product = await fertilizer({ tracksBatch: true, tracksExpiry: true });
    const line = { productId: product.productId, unitId: product.bagId, quantity: "1", unitCost: "40000" };

    expect(Object.keys(await fieldErrorsOf(receiveGoods(world.a.as.ADMIN, delivery([line])))).sort()).toEqual([
      "lines.0.batchNumber",
      "lines.0.expiryDate",
    ]);
    expect(await fieldErrorsOf(receiveGoods(world.a.as.ADMIN, delivery([{ ...line, batchNumber: "B-77", expiryDate: "2026-02-30" }])))).toHaveProperty(
      "lines.0.expiryDate",
    );

    const { id } = await receiveGoods(world.a.as.ADMIN, delivery([{ ...line, batchNumber: "B-77", expiryDate: future }]));
    const receipt = await getReceipt(world.a.as.ADMIN, { receiptId: id });
    expect(receipt.lines[0]).toMatchObject({ batchNumber: "B-77", expiryDate: future });
  });

  it("are refused on a product that is not set up to use them", async () => {
    const errors = await fieldErrorsOf(
      receiveGoods(
        world.a.as.ADMIN,
        delivery([{ productId: world.a.product.id, unitId: world.a.product.packUnitId, quantity: "1", unitCost: "700", batchNumber: "B-1", expiryDate: future }]),
      ),
    );
    expect(Object.keys(errors).sort()).toEqual(["lines.0.batchNumber", "lines.0.expiryDate"]);
  });

  it("can be switched on for an existing product, and the receiving screen is told", async () => {
    await updateProduct(world.a.as.ADMIN, {
      productId: world.a.product.id,
      name: "A Seed Sachet",
      code: "A-001",
      barcode: "",
      categoryId: world.a.categoryId,
      taxable: true,
      tracksBatch: false,
      tracksExpiry: true,
    });
    const options = await getReceivingOptions(world.a.as.STOREKEEPER);
    const product = options.products.find((candidate) => candidate.id === world.a.product.id);
    expect(product).toMatchObject({ tracksBatch: false, tracksExpiry: true, baseUnitName: "single" });
    expect((await listActivity(world.a.as.ADMIN)).entries[0].summary).toMatch(/now uses expiry dates/);
  });
});

describe("expiring soon", () => {
  async function receiveWithExpiry(expiryDate: string, batchNumber: string) {
    const product =
      (await getDb().product.findFirst({ where: { name: "NPK Fertilizer", businessId: world.a.id } })) ??
      { id: (await fertilizer({ tracksBatch: true, tracksExpiry: true })).productId };
    const bag = await getDb().productUnit.findFirstOrThrow({ where: { productId: product.id, name: "bag" } });
    return receiveGoods(world.a.as.ADMIN, delivery([{ productId: product.id, unitId: bag.id, quantity: "1", unitCost: "40000", batchNumber, expiryDate }]));
  }

  it("starts at 3 months and lists deliveries expiring within that time, soonest first, flagging those already expired", async () => {
    const today = shopToday();
    expect((await getBusinessSettings(world.a.as.ADMIN)).expiringSoonMonths).toBe(3);

    await receiveWithExpiry(addMonths(today, 2), "SOON");
    await receiveWithExpiry(addMonths(today, 5), "LATER");
    await receiveWithExpiry(addMonths(today, -1), "GONE");

    const list = await listExpiringSoon(world.a.as.STOREKEEPER);
    expect(list.months).toBe(3);
    expect(list.rows.map((row) => [row.batchNumber, row.expired])).toEqual([
      ["GONE", true],
      ["SOON", false],
    ]);
    expect(list.rows[0]).toMatchObject({ productName: "NPK Fertilizer", stockNow: "150.000", baseUnitName: "kg", unitName: "bag" });
  });

  it("follows the admin's setting, which is separate per business and limited to 1–36 months", async () => {
    const today = shopToday();
    await receiveWithExpiry(addMonths(today, 5), "LATER");
    expect((await listExpiringSoon(world.a.as.ADMIN)).rows).toHaveLength(0);

    await setExpiringSoonMonths(world.a.as.ADMIN, { months: "6" });
    expect((await listExpiringSoon(world.a.as.ADMIN)).rows.map((row) => row.batchNumber)).toEqual(["LATER"]);
    expect((await getBusinessSettings(world.b.as.ADMIN)).expiringSoonMonths).toBe(3);
    expect((await listActivity(world.a.as.ADMIN)).entries[0].summary).toMatch(/from 3 to 6 months/);

    for (const months of ["0", "37", "2.5", "six", ""]) {
      await expect(setExpiringSoonMonths(world.a.as.ADMIN, { months }), months).rejects.toBeInstanceOf(ValidationError);
    }
    await expect(getDb().business.update({ where: { id: world.a.id }, data: { expiringSoonMonths: 0 } })).rejects.toThrow();
  });

  it("shows business B nothing of business A's deliveries", async () => {
    await receiveWithExpiry(addMonths(shopToday(), 1), "SOON");
    expect((await listExpiringSoon(world.b.as.ADMIN)).rows).toEqual([]);
  });
});

describe("backdating a delivery", () => {
  const line = () => [{ productId: world.a.product.id, unitId: world.a.product.packUnitId, quantity: "1", unitCost: "700" }];
  const yesterday = () => addDays(shopToday(), -1);

  function addDays(day: string, days: number): string {
    const date = new Date(`${day}T00:00:00.000Z`);
    date.setUTCDate(date.getUTCDate() + days);
    return date.toISOString().slice(0, 10);
  }

  it("dates a delivery today when no date is given, and it is not marked as backdated", async () => {
    const { id } = await receiveGoods(world.a.as.STOREKEEPER, delivery(line()));
    const receipt = await getReceipt(world.a.as.ADMIN, { receiptId: id });
    expect(receipt).toMatchObject({ receivedOn: shopToday(), backdated: false, backdateNote: null });
  });

  it("refuses an earlier date from a storekeeper, with or without a note", async () => {
    const errors = await fieldErrorsOf(
      receiveGoods(world.a.as.STOREKEEPER, delivery(line(), { receivedOn: yesterday(), backdateNote: "Forgot to enter it yesterday" })),
    );
    expect(errors.receivedOn).toMatch(/Only a manager or admin/);
    expect(await getDb().goodsReceipt.count()).toBe(0);
  });

  it("lets a manager or admin backdate only with a note, and records it clearly", async () => {
    const withoutNote = await fieldErrorsOf(receiveGoods(world.a.as.MANAGER, delivery(line(), { receivedOn: yesterday() })));
    expect(withoutNote.backdateNote).toBeTruthy();
    const tooShort = await fieldErrorsOf(receiveGoods(world.a.as.MANAGER, delivery(line(), { receivedOn: yesterday(), backdateNote: "ok" })));
    expect(tooShort.backdateNote).toBeTruthy();

    const { id } = await receiveGoods(
      world.a.as.MANAGER,
      delivery(line(), { receivedOn: yesterday(), backdateNote: "Delivery arrived after closing yesterday" }),
    );
    const receipt = await getReceipt(world.a.as.ADMIN, { receiptId: id });
    expect(receipt).toMatchObject({
      receivedOn: yesterday(),
      backdated: true,
      backdateNote: "Delivery arrived after closing yesterday",
    });
    // The stock still changed now, and the entry time is the real time.
    expect(await quantityAt(world.a.product.id, world.a.storeroomId)).toBe("10.000");
    expect(Date.now() - receipt.createdAt.getTime()).toBeLessThan(20_000);

    const [latest] = (await listActivity(world.a.as.ADMIN)).entries;
    expect(latest.action).toBe("stock.received_backdated");
    expect(latest.summary).toMatch(/BACKDATED to .* — reason: Delivery arrived after closing yesterday/);
  });

  it("never accepts a future date, an impossible date, or one more than a year back", async () => {
    for (const receivedOn of [addDays(shopToday(), 1), "2026-02-30", addDays(shopToday(), -400)]) {
      const errors = await fieldErrorsOf(
        receiveGoods(world.a.as.ADMIN, delivery(line(), { receivedOn, backdateNote: "A perfectly good reason" })),
      );
      expect(errors.receivedOn, receivedOn).toBeTruthy();
    }
    expect(await getDb().goodsReceipt.count()).toBe(0);
  });

  it("is refused by the database itself if a backdated delivery has no note", async () => {
    await expect(
      getDb().goodsReceipt.create({
        data: {
          businessId: world.a.id,
          requestId: randomUUID(),
          number: 99,
          supplierId: world.a.supplierId,
          supplierName: "X",
          locationId: world.a.storeroomId,
          locationName: "Storeroom",
          receivedOn: new Date("2026-01-01T00:00:00.000Z"),
          backdated: true,
          backdateNote: "   ",
          totalCost: "0",
          createdByName: "Test",
        },
      }),
    ).rejects.toThrow();
  });
});

describe("history is preserved", () => {
  it("keeps a delivery's product name, unit and conversion after they change", async () => {
    const product = await withCarton();
    const { id } = await receiveGoods(world.a.as.ADMIN, delivery([{ productId: product.productId, unitId: product.cartonId, quantity: "2", unitCost: "30000" }]));

    await retireUnit(world.a.as.ADMIN, { unitId: product.cartonId });
    await addUnit(world.a.as.ADMIN, { productId: product.productId, name: "carton", factor: "96", forSale: true, forPurchase: true, price: "8200" });
    await updateProduct(world.a.as.ADMIN, { productId: product.productId, name: "Renamed Sachet", code: "A-001", barcode: "", categoryId: world.a.categoryId, taxable: true });

    const receipt = await getReceipt(world.a.as.ADMIN, { receiptId: id });
    expect(receipt.lines[0]).toMatchObject({ productName: "A Seed Sachet", unitName: "carton", unitFactor: "100.000", baseQuantity: "200.000" });
    expect(await quantityAt(product.productId, world.a.storeroomId)).toBe("200.000");
  });

  it("is refused by the database itself when anyone tries to alter stock history or go below zero", async () => {
    const { id } = await receiveGoods(world.a.as.ADMIN, delivery([{ productId: world.a.product.id, unitId: world.a.product.packUnitId, quantity: "1", unitCost: "700" }]));
    const db = getDb();
    const movement = await db.stockMovement.findFirstOrThrow({ where: { documentId: id } });
    const line = await db.goodsReceiptLine.findFirstOrThrow({ where: { receiptId: id } });

    await expect(db.stockMovement.update({ where: { id: movement.id }, data: { quantityDelta: "999" } })).rejects.toThrow();
    await expect(db.stockMovement.delete({ where: { id: movement.id } })).rejects.toThrow();
    await expect(db.goodsReceipt.update({ where: { id }, data: { totalCost: "1" } })).rejects.toThrow();
    await expect(db.goodsReceipt.delete({ where: { id } })).rejects.toThrow();
    await expect(db.goodsReceiptLine.update({ where: { id: line.id }, data: { unitCost: "1" } })).rejects.toThrow();
    await expect(db.goodsReceiptLine.delete({ where: { id: line.id } })).rejects.toThrow();
    await expect(
      db.stockBalance.updateMany({ where: { productId: world.a.product.id }, data: { quantity: { decrement: "10.001" } } }),
    ).rejects.toThrow();
    expect(await quantityAt(world.a.product.id, world.a.storeroomId)).toBe("10.000");
  });
});

describe("business A cannot receive using business B's records", () => {
  it("refuses B's supplier, location, product or unit, and changes nothing in B", async () => {
    const mine = { productId: world.a.product.id, unitId: world.a.product.packUnitId, quantity: "1", unitCost: "700" };
    const attempts = [
      { ...delivery([mine]), supplierId: world.b.supplierId },
      { ...delivery([mine]), locationId: world.b.storeroomId },
      delivery([{ ...mine, productId: world.b.product.id, unitId: world.b.product.packUnitId }]),
      delivery([{ ...mine, unitId: world.b.product.packUnitId }]),
    ];
    for (const attempt of attempts) {
      await expect(receiveGoods(world.a.as.ADMIN, attempt)).rejects.toBeInstanceOf(ValidationError);
    }
    expect(await getDb().goodsReceipt.count()).toBe(0);
    expect(await getDb().stockBalance.count()).toBe(0);
  });

  it("does not offer B's suppliers, locations or products on A's receiving screen", async () => {
    const options = await getReceivingOptions(world.a.as.STOREKEEPER);
    expect(options.suppliers.map((supplier) => supplier.name)).toEqual(["A Supplies Ltd"]);
    expect(options.locations.map((location) => location.id).sort()).toEqual([world.a.shelfId, world.a.storeroomId].sort());
    expect(options.products.map((product) => product.name)).toEqual(["A Seed Sachet"]);
    expect(options.canBackdate).toBe(false);
    expect((await getReceivingOptions(world.a.as.MANAGER)).canBackdate).toBe(true);
  });
});

describe("deliveries list and stock on hand", () => {
  it("lists deliveries newest first and finds them by supplier, product, number or date", async () => {
    const { id: other } = await createSupplier(world.a.as.ADMIN, { name: "Northern Agro Traders", phone: "", note: "" });
    const line = [{ productId: world.a.product.id, unitId: world.a.product.packUnitId, quantity: "1", unitCost: "700" }];
    await receiveGoods(world.a.as.ADMIN, delivery(line));
    await receiveGoods(world.a.as.ADMIN, delivery(line, { supplierId: other, invoiceNumber: "INV-778" }));

    const viewer = world.a.as.ACCOUNTANT;
    expect((await listReceipts(viewer)).receipts.map((receipt) => receipt.number)).toEqual([2, 1]);
    expect((await listReceipts(viewer, { search: "northern" })).receipts.map((receipt) => receipt.number)).toEqual([2]);
    expect((await listReceipts(viewer, { search: "INV-778" })).total).toBe(1);
    expect((await listReceipts(viewer, { search: "GR-000001" })).receipts.map((receipt) => receipt.number)).toEqual([1]);
    expect((await listReceipts(viewer, { search: "seed sachet" })).total).toBe(2);
    expect((await listReceipts(viewer, { from: shopToday(), to: shopToday() })).total).toBe(2);
    expect((await listReceipts(viewer, { to: "2000-01-01" })).total).toBe(0);
    expect((await listReceipts(world.b.as.ADMIN)).total).toBe(0);
    // Cost prices are part of what delivery viewers see.
    expect((await listReceipts(viewer)).receipts[0].totalCost).toBe("700.00");
  });

  it("shows stock per location and in total, and can be narrowed to products in stock", async () => {
    const product = await withCarton();
    await fertilizer();
    await receiveGoods(world.a.as.ADMIN, delivery([{ productId: product.productId, unitId: product.cartonId, quantity: "2", unitCost: "30000" }]));
    await receiveGoods(
      world.a.as.ADMIN,
      delivery([{ productId: product.productId, unitId: product.packId, quantity: "1", unitCost: "3200" }], { locationId: world.a.shelfId }),
    );

    const all = await listStockOnHand(world.a.as.CASHIER);
    expect(all.rows.map((row) => [row.productName, row.total])).toEqual([
      ["A Seed Sachet", "210.000"],
      ["NPK Fertilizer", "0.000"],
    ]);
    const sachet = all.rows[0];
    expect(sachet.byLocation[world.a.storeroomId]).toBe("200.000");
    expect(sachet.byLocation[world.a.shelfId]).toBe("10.000");
    expect(sachet.baseUnitName).toBe("single");

    expect((await listStockOnHand(world.a.as.CASHIER, { inStock: "1" })).rows.map((row) => row.productName)).toEqual(["A Seed Sachet"]);
    expect((await listStockOnHand(world.a.as.CASHIER, { search: "npk" })).rows.map((row) => row.productName)).toEqual(["NPK Fertilizer"]);
    expect((await listStockOnHand(world.b.as.CASHIER)).rows.map((row) => row.total)).toEqual(["0.000"]);
  });
});

describe("suppliers", () => {
  it("are added, changed and taken out of use, never deleted, and are separate per business", async () => {
    const storekeeper = world.a.as.STOREKEEPER;
    const { id } = await createSupplier(storekeeper, { name: "Kano Seeds Co", phone: "0800 000 0000", note: "" });
    await updateSupplier(storekeeper, { supplierId: id, name: "Kano Seeds Company", phone: "0800 000 0000", note: "Pays on delivery" });
    expect((await listSuppliers(storekeeper)).map((supplier) => supplier.name)).toEqual(["A Supplies Ltd", "Kano Seeds Company"]);

    const errors = await fieldErrorsOf(createSupplier(storekeeper, { name: "kano seeds company", phone: "", note: "" }));
    expect(errors.name).toMatch(/already a supplier/);
    await expect(createSupplier(world.b.as.ADMIN, { name: "Kano Seeds Company", phone: "", note: "" })).resolves.toBeTruthy();

    await setSupplierActive(storekeeper, { supplierId: id, active: false });
    expect(await getDb().supplier.count({ where: { id } })).toBe(1);
    expect((await getReceivingOptions(storekeeper)).suppliers.map((supplier) => supplier.name)).toEqual(["A Supplies Ltd"]);
    const refused = await fieldErrorsOf(
      receiveGoods(storekeeper, {
        ...delivery([{ productId: world.a.product.id, unitId: world.a.product.packUnitId, quantity: "1", unitCost: "700" }]),
        supplierId: id,
      }),
    );
    expect(refused.supplierId).toMatch(/out of use/);
  });
});
