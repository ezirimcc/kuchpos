import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { shopToday } from "@/lib/format";
import { listProducts } from "@/server/business/catalog";
import { getCustomer, listCustomers } from "@/server/business/customers";
import { getDashboard } from "@/server/business/dashboard";
import { exportList } from "@/server/business/exports";
import { runHistoryImport } from "@/server/business/import-history";
import { runSetupImport } from "@/server/business/imports";
import { getOfflineKit } from "@/server/business/offline";
import { getCollectionsReport, getCustomerReport, getDebtReport, getSalesReport, getStockMovements, getStockReport } from "@/server/business/reports";
import { getCheckoutCatalogue, getSale, listSales, postSale } from "@/server/business/sales";
import { listStockOnHand } from "@/server/business/stock";
import { openTill } from "@/server/business/till";
import { getDb } from "@/server/db/client";
import { getOwnerOverview } from "@/server/platform/overview";
import { makeWorkbook, type Rows } from "../support/workbook";
import { createWorld, expectBalancesMatchMovements, expectCustomerBalancesMatchEntries, type World } from "../support/world";

/**
 * How the app behaves with a shop larger than the owner's biggest (M16, C68): 300 products,
 * 1,500 customers and six months of sales at about 150 a day, loaded through the real Excel
 * import — which is thereby timed too. Then the work behind each busy screen is timed.
 *
 * Run with `npm run test:speed` (a quarter of an hour or more; not part of the ordinary tests).
 * The limits are generous on purpose: they catch something that has become badly slow, not a
 * busy computer. The measured times are printed and written to `test-results/speed.txt`.
 */

const PRODUCTS = 300;
const CUSTOMERS = 1_500;
const DAYS = 180;
const SALES_A_DAY = 150;
const DAY = 24 * 60 * 60 * 1000;

let world: World;
const timings: [string, number, string][] = [];
const startingDay = shopToday(new Date(Date.now() - DAYS * DAY));
const about = (fileName: string) => ({ fileName, startingDay });
const typed = (day: string) => `${day.slice(8, 10)}/${day.slice(5, 7)}/${day.slice(0, 4)}`;

/** The same "random" numbers on every run, so runs can be compared. */
let seed = 20261012;
const random = (below: number) => {
  seed = (seed * 1103515245 + 12345) % 2147483648;
  return seed % below;
};

async function timed<T>(what: string, limitSeconds: number, work: () => Promise<T>, note: (result: T) => string = () => ""): Promise<T> {
  const start = performance.now();
  const result = await work();
  const seconds = (performance.now() - start) / 1000;
  timings.push([what, seconds, note(result)]);
  expect(seconds, `${what} took ${seconds.toFixed(1)} s`).toBeLessThan(limitSeconds);
  return result;
}
const kilobytes = (value: unknown) => `${Math.round(JSON.stringify(value).length / 1024)} KB sent to the browser`;

beforeAll(async () => {
  world = await createWorld();
});

afterAll(() => {
  const lines = timings.map(([what, seconds, note]) => `${seconds.toFixed(2).padStart(8)} s  ${what}${note ? `  (${note})` : ""}`);
  const report = [`Large shop: ${PRODUCTS} products, ${CUSTOMERS} customers, ${DAYS} days x ${SALES_A_DAY} sales`, ...lines].join("\n");
  console.log(`\n${report}\n`);
  writeFileSync("test-results/speed.txt", `${report}\n`);
});

describe("a shop larger than the biggest one", () => {
  it("is loaded from Excel: products, customers and stock, then six months of sales", async () => {
    const admin = world.a.as.ADMIN;
    const products: Rows = [];
    const stock: Rows = [];
    for (let n = 1; n <= PRODUCTS; n += 1) {
      const code = `P-${String(n).padStart(4, "0")}`;
      const price = 200 + random(60) * 50;
      products.push({ code, name: `Sample Product ${n}`, category: `Category ${1 + (n % 12)}`, unit: "piece", contains: "1", price: String(price) });
      products.push({ code, name: `Sample Product ${n}`, category: `Category ${1 + (n % 12)}`, unit: "carton", contains: "12", price: String(price * 11) });
      // Plenty of everything, so that six months of sales never run a product out.
      stock.push({ code, unit: "carton", quantity: "5000", cost: String(Math.round(price * 8.4)) });
    }
    const customers: Rows = [];
    for (let n = 1; n <= CUSTOMERS; n += 1) {
      const owes = n % 7 === 0;
      customers.push({ name: `Sample Customer ${n}`, phone: `0801${String(1000000 + n)}`, city: ["Aba", "Owerri", "Umuahia", "Enugu"][n % 4], state: ["Abia", "Imo", "Abia", "Enugu"][n % 4], creditLimit: n % 3 === 0 ? "200000" : "", owed: owes ? String(5000 + random(40) * 500) : "" });
    }
    const setup = await makeWorkbook({ products, customers, stock });
    await timed("Import: 300 products (600 units), 1,500 customers, 300 stock lines", 240, () => runSetupImport(admin, about("large-setup.xlsx"), setup));

    // Six months of sales, fifteen days to a file — about 2,250 sales (4,500 rows) each.
    let receipt = 0;
    for (let part = 0; part < DAYS / 15; part += 1) {
      const sales: Rows = [];
      for (let d = 0; d < 15; d += 1) {
        const day = shopToday(new Date(Date.now() - (DAYS - (part * 15 + d)) * DAY));
        for (let s = 0; s < SALES_A_DAY; s += 1) {
          receipt += 1;
          const minutes = 8 * 60 + Math.floor((s * 600) / SALES_A_DAY);
          const time = `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
          const customer = random(4) === 0 ? 1 + random(CUSTOMERS) : 0;
          const credit = customer !== 0 && customer % 3 === 0 && random(5) === 0;
          const lines = 1 + random(3);
          const paidBy = random(3) === 0 ? "Bank transfer" : "Cash";
          const soldBy = ["Ada", "Bola", "Chidi"][random(3)];
          for (let l = 0; l < lines; l += 1) {
            const n = 1 + random(PRODUCTS);
            sales.push({
              date: typed(day),
              time,
              receipt: `R${receipt}`,
              code: `P-${String(n).padStart(4, "0")}`,
              unit: "piece",
              quantity: String(1 + random(5)),
              price: "250",
              paidBy,
              customerPhone: customer ? `0801${String(1000000 + customer)}` : "",
              onCredit: credit && l === 0 ? "200" : "",
              soldBy,
            });
          }
        }
      }
      const file = await makeWorkbook({ sales });
      const done = await timed(`Import: fifteen days of sales (${SALES_A_DAY * 15} sales, ${sales.length} rows)`, 200, () => runHistoryImport(admin, about(`large-sales-${part + 1}.xlsx`), file));
      expect(done.exceptions).toBe(0);
    }
    const db = getDb();
    expect(await db.sale.count({ where: { businessId: world.a.id } })).toBe(DAYS * SALES_A_DAY);
    // Everything the import wrote still adds up.
    await expectBalancesMatchMovements();
    await expectCustomerBalancesMatchEntries();
  });

  it("stays quick where people work: checkout, lists, reports", async () => {
    const admin = world.a.as.ADMIN;
    const cashier = world.a.as.CASHIER;
    const today = shopToday();
    const monthAgo = shopToday(new Date(Date.now() - 30 * DAY));
    const halfYear = shopToday(new Date(Date.now() - (DAYS - 1) * DAY));

    await timed("Home page figures", 5, () => getDashboard(admin));
    const catalogue = await timed("Opening the checkout (products and customers it keeps)", 5, () => getCheckoutCatalogue(cashier), kilobytes);
    await timed("The kit kept for selling without internet", 5, () => getOfflineKit(cashier), kilobytes);

    await openTill(cashier, { terminalId: world.a.terminalId, openingFloat: "0" });
    const product = catalogue.products.find((entry) => entry.name.startsWith("Sample Product"))!;
    const unit = product.units[0];
    const sale = await timed("Completing a sale of one item", 3, () =>
      postSale(cashier, {
        requestId: randomUUID(),
        terminalId: world.a.terminalId,
        expectedTotal: unit.price,
        payments: [{ methodId: world.a.cashMethodId, amount: unit.price }],
        lines: [{ productId: product.id, unitId: unit.id, quantity: "1", unitPrice: unit.price }],
      }),
    );
    await timed("Opening a receipt", 3, () => getSale(cashier, { saleId: sale.id }));

    await timed("Sales list, first page", 5, () => listSales(admin, {}));
    await timed("Sales list, searched by receipt number", 5, () => listSales(admin, { search: "IMP-R12345" }));
    await timed("Sales list, one day", 5, () => listSales(admin, { from: monthAgo, to: monthAgo }));
    await timed("Products list", 5, () => listProducts(admin, {}));
    await timed("Stock on hand", 5, () => listStockOnHand(admin, {}));
    const customers = await timed("Customers list with purchases and visits", 8, () => listCustomers(admin, {}));
    await timed("Customers list, searched", 8, () => listCustomers(admin, { search: "Customer 77" }));
    await timed("One customer's page", 5, () => getCustomer(admin, { customerId: customers.customers[0].id }));

    await timed("Sales report, today", 5, () => getSalesReport(admin, { from: today, to: today }));
    await timed("Sales report, last 30 days by product", 15, () => getSalesReport(admin, { from: monthAgo, to: today, by: "product" }));
    await timed("Sales report, six months by day", 60, () => getSalesReport(admin, { from: halfYear, to: today, by: "day" }));
    await timed("Collections report, last 30 days", 15, () => getCollectionsReport(admin, { from: monthAgo, to: today }));
    await timed("Customer debts by age", 15, () => getDebtReport(admin));
    await timed("Customer report, last 30 days", 60, () => getCustomerReport(admin, { from: monthAgo, to: today }));
    await timed("Stock figures, last 30 days", 60, () => getStockReport(admin, { from: monthAgo, to: today }));
    await timed("Stock movements, last 30 days, first page", 10, () => getStockMovements(admin, { from: monthAgo, to: today }));
    await timed("Owner's overview of all businesses, last 30 days", 30, () => getOwnerOverview(world.ownerOutside, { from: monthAgo, to: today }));
    await timed("Export of the sales list for one month (CSV)", 120, () => exportList(admin, { list: "sales", from: monthAgo, to: today }), (file) => `${file.rows.length} rows`);
  });
});
