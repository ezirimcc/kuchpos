import "server-only";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { Prisma } from "@/generated/prisma/client";
import { Decimal } from "@/lib/decimal";
import { dayToDate, formatDay, shopDayStart, shopToday } from "@/lib/format";
import { CUSTOMERS_SHEET, PRODUCTS_SHEET, STOCK_SHEET } from "@/lib/import-template";
import { formatNaira, moneyToString, parseMoney, roundMoney, sumMoney } from "@/lib/money";
import { parseQuantity, quantityToString, toBaseQuantity } from "@/lib/quantity";
import { activityRow } from "@/server/activity";
import type { AppContext } from "@/server/auth/context";
import { parseInput } from "@/server/auth/users";
import { businessDb, businessIdOf } from "@/server/db/scoped";
import { takeDocumentNumber } from "@/server/document-number";
import { ValidationError } from "@/server/errors";
import { authorize } from "@/server/permissions";
import type { CheckedLine } from "@/server/receipt-lines";
import { writeGoodsReceipt } from "@/server/receipt-write";
import { cellDay, cellText, cellYesNo, type Problem, readWorkbook, rowsOf } from "@/server/workbook";

/**
 * Bringing a shop's existing records in from its Excel workbook (SPEC §4.8, C66).
 *
 * This file is the SETUP part: products with their units and prices, customers with what
 * they owed, and the stock counted on the starting day. (Deliveries and sales since then are
 * the HISTORY part.)
 *
 * The rules:
 * - The workbook is checked WHOLE before anything is saved, and every problem is reported by
 *   sheet and row. One problem anywhere means nothing is saved.
 * - It is saved in one transaction, or not at all, and the import itself is recorded.
 * - The same file cannot be brought in twice (its fingerprint is kept).
 * - A product (by code) or customer (by phone) that is already in KuchPos is left exactly as
 *   it is — so a workbook can be used again after adding rows — and import never changes or
 *   removes anything that exists. Day-to-day changes are made on the normal screens.
 * - All stock goes onto the Shelf (the shops do not keep Shelf and Storeroom apart yet). It
 *   is saved as one delivery from "Opening stock", with movements of kind OPENING_BALANCE
 *   dated the starting day, so it can be read — and, if a mistake was typed, corrected —
 *   like any other delivery.
 * - What a customer owed is an OPENING_BALANCE line on their account, dated the starting day.
 */

const MAX_MONEY = new Decimal("99999999999.99");
const MAX_FACTOR = new Decimal("999999.999");
const MAX_QUANTITY = new Decimal("9999999.999");
const MAX_PROBLEMS_SHOWN = 200;
export const OPENING_STOCK_SUPPLIER = "Opening stock (brought in)";

const inputSchema = z.object({
  fileName: z.string().trim().min(1).max(200),
  /** The day the stock was counted and the debts were owed: "YYYY-MM-DD". */
  startingDay: z.string().trim(),
});

type NewUnit = { id: string; name: string; factor: Decimal; isBase: boolean; price: Decimal | null; forPurchase: boolean };
type NewProduct = {
  id: string;
  code: string;
  name: string;
  category: string;
  barcode: string;
  allowsFraction: boolean;
  taxable: boolean;
  tracksBatch: boolean;
  tracksExpiry: boolean;
  units: NewUnit[];
};
type NewCustomer = { id: string; name: string; phone: string; address: string; city: string; state: string; creditLimit: Decimal | null; owed: Decimal };
/** A product as the stock sheet needs to know it, whether it is new in this workbook or already in KuchPos. */
type KnownProduct = { id: string; name: string; allowsFraction: boolean; tracksBatch: boolean; tracksExpiry: boolean; units: Map<string, { id: string; name: string; factor: Decimal }> };

export type ImportPreview = {
  fileName: string;
  startingDay: string;
  /** What would be brought in. */
  newProducts: number;
  newUnits: number;
  newCategories: number;
  newCustomers: number;
  openingDebt: string;
  stockLines: number;
  stockValue: string;
  /** Rows left alone because the product or customer is already in KuchPos. */
  productsAlreadyThere: number;
  customersAlreadyThere: number;
  /** Everything wrong with the workbook, by sheet and row; nothing can be saved while there is any. */
  problems: Problem[];
  problemCount: number;
  /** Set when exactly this file has been brought in before. */
  alreadyImported: { number: number; at: Date; byName: string } | null;
  /** True when Confirm would save it. */
  canImport: boolean;
};

type Checked = {
  preview: ImportPreview;
  fileHash: string;
  products: NewProduct[];
  categories: string[];
  customers: NewCustomer[];
  stock: { known: KnownProduct; unitKey: string; quantity: Decimal; unitCost: Decimal; batch: string | null; expiry: Date | null }[];
};

const key = (text: string) => text.trim().toLowerCase();

async function checkSetup(context: AppContext, input: unknown, bytes: Buffer): Promise<Checked> {
  const data = parseInput(inputSchema, input);
  const db = businessDb(context);
  const problems: Problem[] = [];
  const say = (sheet: string, row: number | null, message: string) => problems.push({ sheet, row, message });

  const today = shopToday();
  if (!dayToDate(data.startingDay)) throw new ValidationError("Choose the starting day.", { startingDay: "Choose a real date." });
  if (data.startingDay > today) throw new ValidationError("The starting day cannot be in the future.", { startingDay: "Not in the future." });

  const fileHash = createHash("sha256").update(bytes).digest("hex");
  const workbook = await readWorkbook(bytes);
  const productRows = rowsOf(workbook, PRODUCTS_SHEET, problems);
  const customerRows = rowsOf(workbook, CUSTOMERS_SHEET, problems);
  const stockRows = rowsOf(workbook, STOCK_SHEET, problems);
  if (productRows.length + customerRows.length + stockRows.length === 0) {
    throw new ValidationError("Nothing to bring in: the Products, Customers and Stock sheets have no rows from row 4 down. Rows 1 to 3 (headings, notes, example) are never imported.");
  }

  const [existingProducts, existingCategories, existingCustomers, before] = await Promise.all([
    db.product.findMany({
      select: {
        id: true,
        name: true,
        code: true,
        barcode: true,
        allowsFraction: true,
        tracksBatch: true,
        tracksExpiry: true,
        units: { where: { retiredAt: null }, select: { id: true, name: true, factor: true } },
      },
    }),
    db.category.findMany({ select: { name: true } }),
    db.customer.findMany({ select: { phone: true } }),
    db.importRun.findFirst({ where: { part: "SETUP", fileHash }, select: { number: true, createdAt: true, createdByName: true } }),
  ]);
  const productByCode = new Map(existingProducts.filter((product) => product.code).map((product) => [key(product.code!), product]));
  const namesTaken = new Map(existingProducts.map((product) => [key(product.name), product.code ?? ""]));
  const barcodesTaken = new Set(existingProducts.filter((product) => product.barcode).map((product) => product.barcode!));
  const categoriesKnown = new Map(existingCategories.map((category) => [key(category.name), category.name]));
  const phonesTaken = new Set(existingCustomers.map((customer) => customer.phone));

  const money = (sheet: string, row: number, label: string, text: string): Decimal | null => {
    try {
      const amount = parseMoney(text);
      if (amount.isNegative() || amount.greaterThan(MAX_MONEY)) throw new Error("out of range");
      return amount;
    } catch {
      say(sheet, row, `${label} "${text}" is not a plain amount. Type it as a number such as 1250 or 1250.50, with no commas or ₦ sign.`);
      return null;
    }
  };

  // --- Products: rows are gathered by code -------------------------------------------
  const P = PRODUCTS_SHEET.name;
  const drafts = new Map<string, { firstRow: number; product: NewProduct; sound: boolean }>();
  let productsAlreadyThere = 0;
  const skippedCodes = new Set<string>();
  for (const { row, cells } of productRows) {
    const code = cellText(cells.code);
    const name = cellText(cells.name);
    const unitName = cellText(cells.unit);
    if (!code || !name || !unitName || cellText(cells.contains) === "") {
      say(P, row, "Product code, Product name, Unit name and \"Contains how many of the smallest unit\" must all be filled in.");
      continue;
    }
    if (code.length > 40) say(P, row, `The product code "${code}" is too long (40 characters at most).`);
    if (name.length > 120) say(P, row, "The product name is too long (120 characters at most).");
    if (unitName.length > 40) say(P, row, `The unit name "${unitName}" is too long (40 characters at most).`);
    if (productByCode.has(key(code))) {
      if (!skippedCodes.has(key(code))) productsAlreadyThere += 1;
      skippedCodes.add(key(code));
      continue;
    }

    const fractions = cellYesNo(cells.fractions, false);
    const taxable = cellYesNo(cells.taxable, true);
    const batch = cellYesNo(cells.batch, false);
    const expiry = cellYesNo(cells.expiry, false);
    const bought = cellYesNo(cells.bought, true);
    if (fractions === null || taxable === null || batch === null || expiry === null || bought === null) {
      say(P, row, "The Yes/No columns must hold Yes or No (or be left empty).");
      continue;
    }
    let factor: Decimal | null = null;
    try {
      factor = parseQuantity(cellText(cells.contains));
      if (!factor.greaterThan(0) || factor.greaterThan(MAX_FACTOR)) throw new Error("out of range");
    } catch {
      say(P, row, `"Contains how many of the smallest unit" must be a number above zero (1 for the smallest unit), not "${cellText(cells.contains)}".`);
      factor = null;
    }
    const priceText = cellText(cells.price);
    const price = priceText === "" ? null : money(P, row, "The selling price", priceText);
    if (factor === null || (priceText !== "" && price === null)) continue;

    let draft = drafts.get(key(code));
    if (!draft) {
      const category = cellText(cells.category);
      if (category !== "" && (category.length < 2 || category.length > 60)) say(P, row, "A category name has 2 to 60 characters.");
      draft = {
        firstRow: row,
        sound: true,
        product: { id: randomUUID(), code, name, category, barcode: cellText(cells.barcode), allowsFraction: fractions, taxable, tracksBatch: batch, tracksExpiry: expiry, units: [] },
      };
      drafts.set(key(code), draft);
    } else if (key(draft.product.name) !== key(name)) {
      say(P, row, `The code "${code}" is used for "${draft.product.name}" on row ${draft.firstRow} and for "${name}" here. One code is one product.`);
      continue;
    }
    if (draft.product.units.some((unit) => key(unit.name) === key(unitName))) {
      say(P, row, `"${name}" already has the unit "${unitName}" on an earlier row.`);
      continue;
    }
    draft.product.units.push({ id: randomUUID(), name: unitName, factor, isBase: factor.equals(1), price, forPurchase: bought });
  }
  const seenNames = new Map<string, string>();
  const seenBarcodes = new Map<string, string>();
  for (const { firstRow, product } of drafts.values()) {
    const bases = product.units.filter((unit) => unit.isBase);
    if (bases.length !== 1) {
      say(P, firstRow, `"${product.name}" needs exactly one unit that contains 1 (its smallest unit); it has ${bases.length}.`);
    }
    if (!product.allowsFraction && product.units.some((unit) => !unit.factor.isInteger())) {
      say(P, firstRow, `"${product.name}" is sold in whole units, so each of its units must contain a whole number of the smallest unit.`);
    }
    const taken = namesTaken.get(key(product.name));
    if (taken !== undefined) say(P, firstRow, `A product named "${product.name}" is already in KuchPos${taken ? ` under the code ${taken}` : ""}. Use that code, or a different name.`);
    const twin = seenNames.get(key(product.name));
    if (twin) say(P, firstRow, `"${product.name}" appears under two codes: ${twin} and ${product.code}.`);
    seenNames.set(key(product.name), product.code);
    if (product.barcode) {
      if (product.barcode.length > 64) say(P, firstRow, "The barcode is too long (64 characters at most).");
      if (barcodesTaken.has(product.barcode)) say(P, firstRow, `The barcode ${product.barcode} already belongs to a product in KuchPos.`);
      const other = seenBarcodes.get(product.barcode);
      if (other) say(P, firstRow, `The barcode ${product.barcode} is on two products: ${other} and ${product.code}.`);
      seenBarcodes.set(product.barcode, product.code);
    }
  }
  const products = [...drafts.values()].map((draft) => draft.product);
  const categories = [...new Set(products.map((product) => product.category).filter((name) => name !== "" && !categoriesKnown.has(key(name))).map(key))].map(
    (wanted) => products.find((product) => key(product.category) === wanted)!.category,
  );

  // --- Customers ---------------------------------------------------------------------
  const C = CUSTOMERS_SHEET.name;
  const customers: NewCustomer[] = [];
  const seenPhones = new Map<string, number>();
  let customersAlreadyThere = 0;
  for (const { row, cells } of customerRows) {
    const name = cellText(cells.name);
    const phone = cellText(cells.phone).replace(/[\s\-().]/g, "");
    if (name.length < 2 || name.length > 120) {
      say(C, row, "Enter the customer's name (2 to 120 characters).");
      continue;
    }
    if (!/^\+?\d{7,15}$/.test(phone)) {
      say(C, row, `The phone number "${cellText(cells.phone)}" is not in digits. Type it like 08031234567.`);
      continue;
    }
    if (seenPhones.has(phone)) {
      say(C, row, `The phone number ${phone} is also on row ${seenPhones.get(phone)}. Every customer needs a different one.`);
      continue;
    }
    seenPhones.set(phone, row);
    if (phonesTaken.has(phone)) {
      customersAlreadyThere += 1;
      continue;
    }
    const [address, city, state] = [cellText(cells.address), cellText(cells.city), cellText(cells.state)];
    if (address.length > 200 || city.length > 60 || state.length > 60) {
      say(C, row, "The address (200), city (60) or state (60 characters) is too long.");
      continue;
    }
    const limitText = cellText(cells.creditLimit);
    const owedText = cellText(cells.owed);
    const creditLimit = limitText === "" ? null : money(C, row, "The credit limit", limitText);
    const owed = owedText === "" ? new Decimal(0) : money(C, row, "The amount owed", owedText);
    if ((limitText !== "" && creditLimit === null) || owed === null) continue;
    customers.push({ id: randomUUID(), name, phone, address, city, state, creditLimit, owed });
  }

  // --- Stock on the starting day -----------------------------------------------------
  const S = STOCK_SHEET.name;
  const known = new Map<string, KnownProduct>();
  for (const product of products) {
    known.set(key(product.code), {
      id: product.id,
      name: product.name,
      allowsFraction: product.allowsFraction,
      tracksBatch: product.tracksBatch,
      tracksExpiry: product.tracksExpiry,
      units: new Map(product.units.map((unit) => [key(unit.name), { id: unit.id, name: unit.name, factor: unit.factor }])),
    });
  }
  const alreadyOpened = new Set(
    stockRows.length > 0
      ? (await db.stockMovement.findMany({ where: { type: "OPENING_BALANCE" }, distinct: ["productId"], select: { productId: true } })).map((movement) => movement.productId)
      : [],
  );
  const stock: Checked["stock"] = [];
  for (const { row, cells } of stockRows) {
    const code = cellText(cells.code);
    const unitName = cellText(cells.unit);
    if (!code || !unitName || cellText(cells.quantity) === "" || cellText(cells.cost) === "") {
      say(S, row, "Product code, Unit, Quantity counted and Cost per unit must all be filled in.");
      continue;
    }
    let product = known.get(key(code));
    const inKuchPos = productByCode.get(key(code));
    if (!product && inKuchPos) {
      product = {
        id: inKuchPos.id,
        name: inKuchPos.name,
        allowsFraction: inKuchPos.allowsFraction,
        tracksBatch: inKuchPos.tracksBatch,
        tracksExpiry: inKuchPos.tracksExpiry,
        units: new Map(inKuchPos.units.map((unit) => [key(unit.name), { id: unit.id, name: unit.name, factor: new Decimal(unit.factor.toFixed(3)) }])),
      };
      known.set(key(code), product);
    }
    if (!product) {
      say(S, row, `The product code "${code}" is not on the Products sheet and not in KuchPos.`);
      continue;
    }
    if (alreadyOpened.has(product.id)) {
      say(S, row, `"${product.name}" already has opening stock in KuchPos. Take this row out; correct stock with a count and an adjustment.`);
      continue;
    }
    if (!product.units.has(key(unitName))) {
      say(S, row, `"${product.name}" has no unit called "${unitName}". Its units are: ${[...product.units.values()].map((unit) => unit.name).join(", ")}.`);
      continue;
    }
    let quantity: Decimal;
    try {
      quantity = parseQuantity(cellText(cells.quantity));
      if (!quantity.greaterThan(0) || quantity.greaterThan(MAX_QUANTITY)) throw new Error("out of range");
    } catch {
      say(S, row, `The quantity "${cellText(cells.quantity)}" must be a number above zero.`);
      continue;
    }
    if (!product.allowsFraction && !quantity.isInteger()) {
      say(S, row, `"${product.name}" is counted in whole units; ${cellText(cells.quantity)} is not a whole number.`);
      continue;
    }
    const unitCost = money(S, row, "The cost per unit", cellText(cells.cost));
    if (unitCost === null) continue;
    const batch = cellText(cells.batch);
    const expiryGiven = cells.expiry !== null && cellText(cells.expiry) !== "";
    const expiryDay = expiryGiven ? cellDay(cells.expiry) : null;
    if (expiryGiven && !expiryDay) {
      say(S, row, `The expiry date "${cellText(cells.expiry)}" is not a date. Type it as day/month/year, for example 31/03/2027.`);
      continue;
    }
    if (product.tracksBatch && batch === "") say(S, row, `"${product.name}" has batch numbers, so the batch must be filled in.`);
    if (product.tracksExpiry && !expiryDay) say(S, row, `"${product.name}" has expiry dates, so the expiry date must be filled in.`);
    if (batch.length > 60) say(S, row, "The batch is too long (60 characters at most).");
    stock.push({ known: product, unitKey: key(unitName), quantity, unitCost, batch: product.tracksBatch ? batch || null : null, expiry: product.tracksExpiry && expiryDay ? dayToDate(expiryDay) : null });
  }

  const stockValue = sumMoney(stock.map((line) => roundMoney(line.quantity.times(line.unitCost))));
  problems.sort((a, b) => a.sheet.localeCompare(b.sheet) || (a.row ?? 0) - (b.row ?? 0));
  const nothingNew = products.length + customers.length + stock.length === 0;
  if (nothingNew && problems.length === 0) {
    say("", null, "Everything in this workbook is already in KuchPos, so there is nothing to bring in.");
  }
  return {
    fileHash,
    products,
    categories,
    customers,
    stock,
    preview: {
      fileName: data.fileName,
      startingDay: data.startingDay,
      newProducts: products.length,
      newUnits: products.reduce((count, product) => count + product.units.length, 0),
      newCategories: categories.length,
      newCustomers: customers.length,
      openingDebt: moneyToString(sumMoney(customers.map((customer) => customer.owed))),
      stockLines: stock.length,
      stockValue: moneyToString(stockValue),
      productsAlreadyThere,
      customersAlreadyThere,
      problems: problems.slice(0, MAX_PROBLEMS_SHOWN),
      problemCount: problems.length,
      alreadyImported: before ? { number: before.number, at: before.createdAt, byName: before.createdByName } : null,
      canImport: problems.length === 0 && !before,
    },
  };
}

/** Reads the workbook and says what would be brought in and what is wrong with it. Saves nothing. */
export async function previewSetupImport(context: AppContext, input: unknown, bytes: Buffer): Promise<ImportPreview> {
  authorize(context, "import.run");
  return (await checkSetup(context, input, bytes)).preview;
}

export type ImportResult = { id: string; number: number; preview: ImportPreview };

/**
 * Brings the workbook in: every new product, unit, price, category and customer, what each
 * customer owed, and the stock counted on the starting day — all of it, or none of it.
 * Refused if the workbook has any problem, or if this exact file was brought in before.
 */
export async function runSetupImport(context: AppContext, input: unknown, bytes: Buffer): Promise<ImportResult> {
  authorize(context, "import.run");
  const businessId = businessIdOf(context);
  const checked = await checkSetup(context, input, bytes);
  const { preview } = checked;
  if (preview.alreadyImported) {
    throw new ValidationError(
      `Nothing was brought in: this exact file was already brought in as ${importNumber(preview.alreadyImported.number)} by ${preview.alreadyImported.byName}. ` +
        "If you have added rows since, save the workbook and upload it again.",
    );
  }
  if (preview.problemCount > 0) {
    throw new ValidationError(`Nothing was brought in: the workbook has ${preview.problemCount === 1 ? "a problem" : `${preview.problemCount} problems`}. Correct them in Excel and upload it again.`);
  }
  const db = businessDb(context);
  const startOfDay = shopDayStart(preview.startingDay)!;
  const who = { userId: context.actor.userId, name: context.actor.name };

  try {
    return await db.$transaction(
      async (tx) => {
        const number = await takeDocumentNumber(tx, businessId, "IMPORT");
        const label = importNumber(number);
        // Written first: the unique fingerprint is what stops the same file going in twice at once.
        const run = await tx.importRun.create({
          data: {
            businessId,
            number,
            part: "SETUP",
            fileHash: checked.fileHash,
            fileName: preview.fileName,
            startingDay: dayToDate(preview.startingDay),
            summary: JSON.stringify({
              products: preview.newProducts,
              units: preview.newUnits,
              categories: preview.newCategories,
              customers: preview.newCustomers,
              openingDebt: preview.openingDebt,
              stockLines: preview.stockLines,
              stockValue: preview.stockValue,
              productsAlreadyThere: preview.productsAlreadyThere,
              customersAlreadyThere: preview.customersAlreadyThere,
            }),
            createdByUserId: who.userId,
            createdByName: who.name,
          },
        });

        // Categories, products, units and their first prices.
        if (checked.categories.length > 0) await tx.category.createMany({ data: checked.categories.map((name) => ({ businessId, name })) });
        const categoryId = new Map((await tx.category.findMany({ select: { id: true, name: true } })).map((category) => [key(category.name), category.id]));
        if (checked.products.length > 0) {
          await tx.product.createMany({
            data: checked.products.map((product) => ({
              id: product.id,
              businessId,
              name: product.name,
              code: product.code,
              barcode: product.barcode || null,
              categoryId: product.category ? (categoryId.get(key(product.category)) ?? null) : null,
              allowsFraction: product.allowsFraction,
              taxable: product.taxable,
              tracksBatch: product.tracksBatch,
              tracksExpiry: product.tracksExpiry,
            })),
          });
          const units = checked.products.flatMap((product) => product.units.map((unit) => ({ product, unit })));
          await tx.productUnit.createMany({
            data: units.map(({ product, unit }) => ({
              id: unit.id,
              businessId,
              productId: product.id,
              name: unit.name,
              activeName: unit.name,
              factor: quantityToString(unit.factor),
              isBase: unit.isBase,
              forSale: unit.price !== null,
              forPurchase: unit.forPurchase,
              price: unit.price ? moneyToString(unit.price) : null,
            })),
          });
          const priced = units.filter(({ unit }) => unit.price !== null);
          if (priced.length > 0) {
            await tx.priceChange.createMany({
              data: priced.map(({ product, unit }) => ({
                businessId,
                productId: product.id,
                productUnitId: unit.id,
                unitName: unit.name,
                oldPrice: null,
                newPrice: moneyToString(unit.price!),
                changedByUserId: who.userId,
                changedByName: who.name,
              })),
            });
          }
        }

        // Customers, their credit limits, and what they owed on the starting day.
        if (checked.customers.length > 0) {
          await tx.customer.createMany({
            data: checked.customers.map((customer) => ({
              id: customer.id,
              businessId,
              name: customer.name,
              phone: customer.phone,
              address: customer.address || null,
              city: customer.city || null,
              state: customer.state || null,
              creditLimit: customer.creditLimit ? moneyToString(customer.creditLimit) : null,
              balance: moneyToString(customer.owed),
            })),
          });
          const limited = checked.customers.filter((customer) => customer.creditLimit !== null);
          if (limited.length > 0) {
            await tx.creditLimitChange.createMany({
              data: limited.map((customer) => ({ businessId, customerId: customer.id, oldLimit: null, newLimit: moneyToString(customer.creditLimit!), changedByUserId: who.userId, changedByName: who.name })),
            });
          }
          const owing = checked.customers.filter((customer) => customer.owed.greaterThan(0));
          if (owing.length > 0) {
            await tx.customerAccountEntry.createMany({
              data: owing.map((customer) => ({
                businessId,
                customerId: customer.id,
                type: "OPENING_BALANCE" as const,
                amount: moneyToString(customer.owed),
                balanceAfter: moneyToString(customer.owed),
                documentNumber: label,
                note: `Owed on ${formatDay(preview.startingDay)}, before KuchPos.`,
                createdByUserId: who.userId,
                createdByName: who.name,
                createdAt: startOfDay,
              })),
            });
          }
        }

        // The stock counted on the starting day: one delivery from "Opening stock", onto the Shelf.
        if (checked.stock.length > 0) {
          const shelf = await tx.location.findFirst({ where: { kind: "SHELF" }, select: { id: true, name: true } });
          if (!shelf) throw new ValidationError("This business has no Shelf to put the stock on. Ask the owner to check its locations.");
          const supplier =
            (await tx.supplier.findFirst({ where: { name: OPENING_STOCK_SUPPLIER }, select: { id: true, name: true } })) ??
            (await tx.supplier.create({ data: { businessId, name: OPENING_STOCK_SUPPLIER, note: "Not a real supplier: stock the shop already held when it started using KuchPos." }, select: { id: true, name: true } }));
          const lines: CheckedLine[] = checked.stock.map((line) => {
            const unit = line.known.units.get(line.unitKey)!;
            return {
              productId: line.known.id,
              productUnitId: unit.id,
              productName: line.known.name,
              unitName: unit.name,
              unitFactor: quantityToString(unit.factor),
              quantity: quantityToString(line.quantity),
              baseQuantity: toBaseQuantity(line.quantity, unit.factor),
              unitCost: moneyToString(line.unitCost),
              lineCost: roundMoney(line.quantity.times(line.unitCost)),
              batchNumber: line.batch,
              expiryDate: line.expiry,
            };
          });
          await writeGoodsReceipt(tx, context, {
            requestId: run.id,
            supplier,
            location: shelf,
            receivedOn: preview.startingDay,
            backdated: preview.startingDay < shopToday(),
            backdateNote: `Stock counted on ${formatDay(preview.startingDay)}, brought in from Excel (${label}).`,
            invoiceNumber: null,
            note: `Opening stock from ${preview.fileName}`.slice(0, 300),
            lines,
            imported: { movementType: "OPENING_BALANCE", at: startOfDay, label: `the stock counted on ${formatDay(preview.startingDay)} (${label})` },
          });
        }

        await tx.activityLog.create({
          data: activityRow(context, {
            action: "import.setup",
            summary:
              `${who.name} brought in ${preview.fileName} (${label}): ${preview.newProducts} products, ${preview.newCustomers} customers owing ` +
              `${formatNaira(new Decimal(preview.openingDebt))}, and ${preview.stockLines} lines of stock worth ${formatNaira(new Decimal(preview.stockValue))} at cost.`,
            targetType: "import_run",
            targetId: run.id,
          }),
        });
        return { id: run.id, number, preview };
      },
      // A workbook can hold thousands of rows: far more time is allowed than for a sale.
      { isolationLevel: "ReadCommitted", timeout: 300_000, maxWait: 20_000 },
    );
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      throw new ValidationError(
        "Nothing was brought in: something in the workbook was added to KuchPos while it was being checked (the same file sent twice, or a product or customer created at the same moment). Upload it again to see where it stands.",
      );
    }
    throw error;
  }
}

/** IM-000012: the number of an import. */
export function importNumber(number: number): string {
  return `IM-${String(number).padStart(6, "0")}`;
}

export type ImportRecord = { id: string; number: number; part: "SETUP" | "HISTORY"; fileName: string; startingDay: string | null; summary: Record<string, string | number>; byName: string; at: Date };

/** Every import into this business, newest first. */
export async function listImports(context: AppContext): Promise<ImportRecord[]> {
  authorize(context, "import.run");
  const rows = await businessDb(context).importRun.findMany({ orderBy: { number: "desc" }, take: 100 });
  return rows.map((row) => ({
    id: row.id,
    number: row.number,
    part: row.part,
    fileName: row.fileName,
    startingDay: row.startingDay ? row.startingDay.toISOString().slice(0, 10) : null,
    summary: JSON.parse(row.summary) as Record<string, string | number>,
    byName: row.createdByName,
    at: row.createdAt,
  }));
}
