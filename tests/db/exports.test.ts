import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { toCsv } from "@/lib/csv";
import { createCustomer } from "@/server/business/customers";
import { exportList } from "@/server/business/exports";
import { postSale } from "@/server/business/sales";
import { receiveGoods } from "@/server/business/stock";
import { openTill } from "@/server/business/till";
import { ForbiddenError, ValidationError } from "@/server/errors";
import { createWorld, type World } from "../support/world";

/** The list pages as CSV files (C66): what the screen shows, every page of it, to those who may export. */

let world: World;

beforeEach(async () => {
  world = await createWorld();
  await receiveGoods(world.a.as.ADMIN, {
    requestId: randomUUID(),
    supplierId: world.a.supplierId,
    locationId: world.a.shelfId,
    lines: [{ productId: world.a.product.id, unitId: world.a.product.baseUnitId, quantity: "100", unitCost: "50" }],
  });
  await openTill(world.a.as.CASHIER, { terminalId: world.a.terminalId, openingFloat: "1000" });
});

describe("exporting a list", () => {
  it("writes products one row per unit, and stock with a column for each place", async () => {
    const products = await exportList(world.a.as.ACCOUNTANT, { list: "products" });
    expect(products.filename).toMatch(/^products_\d{4}-\d{2}-\d{2}\.csv$/);
    expect(products.header.slice(0, 7)).toEqual(["Product", "Code", "Barcode", "Category", "Unit", "Contains (smallest units)", "Selling price"]);
    expect(products.rows.map((row) => row.slice(0, 7)).sort((a, b) => String(a[4]).localeCompare(String(b[4])))).toEqual([
      ["A Seed Sachet", "A-001", null, "Seeds", "pack", "10", "900.00"],
      ["A Seed Sachet", "A-001", null, "Seeds", "single", "1", "100.00"],
    ]);

    const stock = await exportList(world.a.as.MANAGER, { list: "stock" });
    expect(stock.header).toEqual(["Product", "Code", "Category", "Unit", "Shelf", "Storeroom", "In all"]);
    expect(stock.rows).toEqual([["A Seed Sachet", "A-001", "Seeds", "single", "100", "0", "100"]]);
    // The filters on screen are the filters of the file.
    expect((await exportList(world.a.as.MANAGER, { list: "stock", search: "no such product" })).rows).toEqual([]);
    expect((await exportList(world.a.as.MANAGER, { list: "products", search: "seed" })).rows).toHaveLength(2);
  });

  it("holds every page of the list, not just the one on screen", async () => {
    for (let index = 1; index <= 60; index += 1) {
      await createCustomer(world.a.as.CASHIER, { name: `Customer ${String(index).padStart(2, "0")}`, phone: `0803000${String(index).padStart(4, "0")}`, city: index % 2 ? "Aba" : "Lagos" });
    }
    const customers = await exportList(world.a.as.ADMIN, { list: "customers", page: "2" });
    expect(customers.rows).toHaveLength(60);
    expect(customers.header).toEqual(["Customer", "Phone", "City", "State", "Credit limit", "Owes now", "Total purchases", "Visits", "In use"]);
    expect(customers.rows[0]).toEqual(["Customer 01", "08030000001", "Aba", null, null, "0.00", "0.00", 0, "Yes"]);
    expect((await exportList(world.a.as.ADMIN, { list: "customers", search: "lagos" })).rows).toHaveLength(30);
    // Each of those 60 is in the activity log too, with the till and the delivery before them.
    const activity = await exportList(world.a.as.ADMIN, { list: "activity", search: "added the customer" });
    expect(activity.rows).toHaveLength(60);
    expect(activity.rows[0].slice(1)).toEqual(["Test a.cashier", "CASHIER", 'Test a.cashier added the customer "Customer 60" (08030000060).']);
  }, 60_000);

  it("writes sales, deliveries and till sessions as the lists show them", async () => {
    const sale = await postSale(world.a.as.CASHIER, {
      requestId: randomUUID(),
      terminalId: world.a.terminalId,
      expectedTotal: "300.00",
      payments: [{ methodId: world.a.cashMethodId, amount: "300.00" }],
      lines: [{ productId: world.a.product.id, unitId: world.a.product.baseUnitId, quantity: "3", unitPrice: "100.00" }],
    });
    const sales = await exportList(world.a.as.ACCOUNTANT, { list: "sales" });
    expect(sales.header).toEqual(["Receipt", "When", "Customer", "Served by", "Lines", "Products", "Total", "On credit", "Cancelled"]);
    expect(sales.rows).toHaveLength(1);
    expect([sales.rows[0][0], ...sales.rows[0].slice(2)]).toEqual([sale.receiptNumber, "Walk-in", "Test a.cashier", 1, "A Seed Sachet", "300.00", "0.00", "No"]);
    expect(sales.rows[0][1]).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);

    const deliveries = await exportList(world.a.as.ACCOUNTANT, { list: "deliveries" });
    expect(deliveries.rows[0].slice(0, 9)).toEqual(["GR-000001", deliveries.rows[0][1], "A Supplies Ltd", "Shelf", 1, "5000.00", "No", 0, "Test a.admin"]);
    const tills = await exportList(world.a.as.MANAGER, { list: "tills" });
    expect(tills.rows[0].slice(0, 3)).toEqual(["TS-000001", "T1", "Test a.cashier"]);
    for (const list of ["returns", "transfers", "adjustments"]) {
      expect((await exportList(world.a.as.ADMIN, { list })).rows, list).toEqual([]);
    }
    // The file itself: a header line and one line per row.
    expect(toCsv(sales.header, sales.rows).trim().split("\r\n")).toHaveLength(2);
  });

  it("needs the right to export; shows another business nothing; refuses a list that does not exist", async () => {
    for (const role of ["CASHIER", "STOREKEEPER"] as const) {
      for (const list of ["products", "stock", "sales", "customers"]) {
        await expect(exportList(world.a.as[role], { list }), `${role} ${list}`).rejects.toBeInstanceOf(ForbiddenError);
      }
    }
    expect((await exportList(world.b.as.ADMIN, { list: "stock" })).rows).toEqual([["B Seed Sachet", "B-001", "Seeds", "single", "0", "0", "0"]]);
    expect((await exportList(world.b.as.ADMIN, { list: "deliveries" })).rows).toEqual([]);
    await expect(exportList(world.a.as.ADMIN, { list: "passwords" })).rejects.toBeInstanceOf(ValidationError);
    await expect(exportList(world.ownerOutside, { list: "products" })).rejects.toBeInstanceOf(ForbiddenError);
    expect((await exportList(world.ownerInA, { list: "products" })).rows).toHaveLength(2);
  });
});
