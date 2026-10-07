import "server-only";
import { z } from "zod";
import { Prisma } from "@/generated/prisma/client";
import { Decimal } from "@/lib/decimal";
import { plainNumber, saleReceiptNumber, shopDayEnd, shopDayStart } from "@/lib/format";
import { formatNaira, lineTotal, moneyToString, parseMoney, roundMoney, sumMoney, taxIncludedIn } from "@/lib/money";
import { parseQuantity, quantityToString, toBaseQuantity } from "@/lib/quantity";
import { activityRow } from "@/server/activity";
import type { AppContext } from "@/server/auth/context";
import { parseInput } from "@/server/auth/users";
import { businessDb, businessIdOf } from "@/server/db/scoped";
import { NotFoundError, ValidationError } from "@/server/errors";
import { PAGE_SIZE, type Paged, paged, pageNumber } from "@/server/paging";
import { authorize, can } from "@/server/permissions";

/**
 * Selling, for the business in use.
 *
 * `postSale` is the ONE place a sale is saved. The checkout screen calls it now; offline
 * sync (M12) must call the same function. It receives the whole sale in one message —
 * with the prices and the total the cashier saw — and works everything out again itself:
 * nothing the browser sends about money is trusted, only compared.
 *
 * A sale, its lines, the stock movements, the balances and the payment are saved in one
 * database transaction. Sales are add-only.
 */

const MAX_LINES = 200;
const MAX_UNIT_QUANTITY = new Decimal("9999999.999");
const MAX_BASE_QUANTITY = new Decimal("999999999.999");
const MAX_MONEY = new Decimal("99999999999.99");
/** How many times to try again when the database reports that two savers got in each other's way. */
const MAX_ATTEMPTS = 3;

// ---------------------------------------------------------------------------
// What the checkout screen keeps in the browser
// ---------------------------------------------------------------------------

export type CheckoutProduct = {
  id: string;
  name: string;
  code: string | null;
  barcode: string | null;
  allowsFraction: boolean;
  baseUnitName: string;
  /** Units on sale with their preset prices, smallest first. */
  units: { id: string; name: string; factor: string; price: string }[];
  /** Stock in base units when this copy was made — a guide for the cashier; the server decides. */
  onShelf: string;
  inStoreroom: string;
};

export type CheckoutCatalogue = {
  businessName: string;
  /** Tax rate in percent, e.g. "7.50". Prices already include it. */
  taxRatePercent: string;
  terminals: { id: string; code: string; name: string }[];
  /** True when this person may take a line from the Storeroom instead of the Shelf. */
  canSellFromStoreroom: boolean;
  products: CheckoutProduct[];
};

export async function getCheckoutCatalogue(context: AppContext): Promise<CheckoutCatalogue> {
  authorize(context, "sale.create");
  const db = businessDb(context);
  const [business, terminals, locations, products] = await Promise.all([
    db.business.findFirst({ select: { name: true, taxRatePercent: true } }),
    db.terminal.findMany({ where: { deactivatedAt: null }, orderBy: { code: "asc" }, select: { id: true, code: true, name: true } }),
    db.location.findMany({ select: { id: true, kind: true } }),
    db.product.findMany({
      where: { deactivatedAt: null, units: { some: { retiredAt: null, forSale: true, price: { not: null } } } },
      orderBy: { name: "asc" },
      select: {
        id: true,
        name: true,
        code: true,
        barcode: true,
        allowsFraction: true,
        units: { where: { retiredAt: null }, orderBy: { factor: "asc" }, select: { id: true, name: true, factor: true, isBase: true, forSale: true, price: true } },
        stockBalances: { select: { locationId: true, quantity: true } },
      },
    }),
  ]);
  if (!business) throw new NotFoundError("That business could not be found.");
  const kindOf = new Map(locations.map((location) => [location.id, location.kind]));
  const held = (balances: { locationId: string; quantity: Prisma.Decimal }[], kind: "SHELF" | "STOREROOM") =>
    quantityToString(
      balances.filter((balance) => kindOf.get(balance.locationId) === kind).reduce((sum, balance) => sum.plus(balance.quantity.toFixed(3)), new Decimal(0)),
    );

  return {
    businessName: business.name,
    taxRatePercent: business.taxRatePercent.toFixed(2),
    terminals,
    canSellFromStoreroom: can(context, "sale.fromStoreroom"),
    products: products.map((product) => ({
      id: product.id,
      name: product.name,
      code: product.code,
      barcode: product.barcode,
      allowsFraction: product.allowsFraction,
      baseUnitName: product.units.find((unit) => unit.isBase)?.name ?? "",
      units: product.units
        .filter((unit) => unit.forSale && unit.price !== null)
        .map((unit) => ({ id: unit.id, name: unit.name, factor: unit.factor.toFixed(3), price: unit.price!.toFixed(2) })),
      onShelf: held(product.stockBalances, "SHELF"),
      inStoreroom: held(product.stockBalances, "STOREROOM"),
    })),
  };
}

// ---------------------------------------------------------------------------
// Saving a sale
// ---------------------------------------------------------------------------

const saleSchema = z.object({
  /** The sale's unique ID, made up on the cashier's computer. */
  requestId: z.string().uuid("This sale has expired. Start a new sale."),
  terminalId: z.string().uuid("Choose the checkout terminal."),
  /** The clock of the cashier's computer, if sent. */
  deviceTime: z.string().datetime().optional(),
  /** The total the cashier saw. The server works the total out again and refuses the sale if they differ. */
  expectedTotal: z.string().trim(),
  /** Cash handed over by the customer. */
  tendered: z.string().trim(),
  lines: z
    .array(
      z.object({
        productId: z.string().trim(),
        unitId: z.string().trim(),
        quantity: z.string().trim(),
        /** The price of one unit as the cashier saw it. */
        unitPrice: z.string().trim(),
        fromStoreroom: z.boolean().optional().default(false),
      }),
    )
    .min(1, "Add at least one product to the sale.")
    .max(MAX_LINES, `A sale can have at most ${MAX_LINES} lines.`),
});

export type SaleResult = {
  id: string;
  receiptNumber: string;
  total: string;
  tendered: string;
  change: string;
  alreadySaved: boolean;
};

type CheckedLine = {
  index: number;
  productId: string;
  productUnitId: string;
  productName: string;
  baseUnitName: string;
  unitName: string;
  unitFactor: string;
  quantity: string;
  baseQuantity: Decimal;
  unitPrice: Decimal;
  lineTotal: Decimal;
  taxable: boolean;
  location: { id: string; name: string };
};

const NOTHING_SOLD = "Nothing was sold. Please correct what is marked.";

/**
 * Saves a cash sale: the sale, its lines, the stock leaving the Shelf (or Storeroom), and the
 * payment — all of it, or none of it. Sending the same `requestId` again returns the sale
 * that was already saved and changes nothing.
 *
 * Refused when: a price or the total differs from what the server works out; a location
 * does not hold enough; the cash handed over is less than the total.
 */
export async function postSale(context: AppContext, input: unknown): Promise<SaleResult> {
  authorize(context, "sale.create");
  authorize(context, "payment.take");
  const businessId = businessIdOf(context);
  const data = parseInput(saleSchema, input);
  const db = businessDb(context);

  const alreadySaved = async (): Promise<SaleResult | null> => {
    const saved = await db.sale.findFirst({
      where: { requestId: data.requestId },
      select: { id: true, receiptNumber: true, total: true, payments: { select: { tendered: true, changeGiven: true } } },
    });
    if (!saved) return null;
    return {
      id: saved.id,
      receiptNumber: saved.receiptNumber,
      total: saved.total.toFixed(2),
      tendered: (saved.payments[0]?.tendered ?? saved.total).toFixed(2),
      change: (saved.payments[0]?.changeGiven ?? new Decimal(0)).toFixed(2),
      alreadySaved: true,
    };
  };
  const repeat = await alreadySaved();
  if (repeat) return repeat;

  const fieldErrors: Record<string, string> = {};

  // --- Terminal and locations ------------------------------------------------------
  const [terminal, locations] = await Promise.all([
    db.terminal.findFirst({ where: { id: data.terminalId }, select: { id: true, code: true, deactivatedAt: true } }),
    db.location.findMany({ select: { id: true, name: true, kind: true } }),
  ]);
  if (!terminal) fieldErrors.terminalId = "Choose the checkout terminal.";
  else if (terminal.deactivatedAt) fieldErrors.terminalId = "This checkout terminal is out of use. Choose another.";
  const shelf = locations.find((location) => location.kind === "SHELF");
  const storeroom = locations.find((location) => location.kind === "STOREROOM");
  if (!shelf) throw new ValidationError("This business has no Shelf to sell from. Ask the admin to check the locations.");
  const mayUseStoreroom = can(context, "sale.fromStoreroom");

  // --- The lines -------------------------------------------------------------------
  const productIds = [...new Set(data.lines.map((line) => line.productId).filter(Boolean))];
  const products = await db.product.findMany({
    where: { id: { in: productIds } },
    select: {
      id: true,
      name: true,
      allowsFraction: true,
      taxable: true,
      deactivatedAt: true,
      units: { select: { id: true, name: true, factor: true, isBase: true, forSale: true, price: true, retiredAt: true } },
    },
  });
  const productById = new Map(products.map((product) => [product.id, product]));

  const checked: CheckedLine[] = [];
  data.lines.forEach((line, index) => {
    const at = (field: string) => `lines.${index}.${field}`;
    const product = productById.get(line.productId);
    if (!product) {
      fieldErrors[at("productId")] = "This product could not be found. Remove the line and add it again.";
      return;
    }
    if (product.deactivatedAt) {
      fieldErrors[at("productId")] = `"${product.name}" is no longer on sale. Remove this line.`;
      return;
    }
    const unit = product.units.find((candidate) => candidate.id === line.unitId);
    if (!unit || unit.retiredAt || !unit.forSale || unit.price === null) {
      fieldErrors[at("unitId")] = `"${product.name}" is no longer sold in that unit. Reload the page to get the latest products.`;
      return;
    }

    let location = shelf;
    if (line.fromStoreroom) {
      if (!mayUseStoreroom || !storeroom) {
        fieldErrors[at("fromStoreroom")] = "Only a manager or admin can sell straight from the Storeroom.";
        return;
      }
      location = storeroom;
    }

    // The price is the server's own. What the cashier saw is only compared with it.
    const price = new Decimal(unit.price.toFixed(2));
    let seen: Decimal | null = null;
    try {
      seen = parseMoney(line.unitPrice);
    } catch {
      seen = null;
    }
    if (!seen || !seen.equals(price)) {
      fieldErrors[at("unitPrice")] =
        `The price of ${product.name} (${unit.name}) is ${formatNaira(price)}` +
        (seen ? `, not ${formatNaira(seen)}` : "") +
        ". Reload the page to get the latest prices.";
      return;
    }

    try {
      const quantity = parseQuantity(line.quantity);
      if (!quantity.greaterThan(0) || quantity.greaterThan(MAX_UNIT_QUANTITY)) throw new Error("out of range");
      if (!product.allowsFraction && !quantity.isInteger()) {
        fieldErrors[at("quantity")] = `"${product.name}" is sold in whole units only. Enter a whole number.`;
        return;
      }
      const baseQuantity = toBaseQuantity(quantity, new Decimal(unit.factor.toFixed(3)));
      if (baseQuantity.greaterThan(MAX_BASE_QUANTITY)) throw new Error("too large");
      const amount = lineTotal(quantity, price);
      if (amount.greaterThan(MAX_MONEY)) throw new Error("too large");
      checked.push({
        index,
        productId: product.id,
        productUnitId: unit.id,
        productName: product.name,
        baseUnitName: product.units.find((candidate) => candidate.isBase)?.name ?? "",
        unitName: unit.name,
        unitFactor: unit.factor.toFixed(3),
        quantity: quantityToString(quantity),
        baseQuantity,
        unitPrice: price,
        lineTotal: amount,
        taxable: product.taxable,
        location: { id: location.id, name: location.name },
      });
    } catch {
      fieldErrors[at("quantity")] = "Enter how many, as a number greater than zero (up to 3 decimal places).";
    }
  });

  // --- Total and cash --------------------------------------------------------------
  const total = sumMoney(checked.map((line) => line.lineTotal));
  const linesAreSound = Object.keys(fieldErrors).every((key) => !key.startsWith("lines."));
  let tendered: Decimal | null = null;
  try {
    tendered = parseMoney(data.tendered);
    if (tendered.isNegative() || tendered.greaterThan(MAX_MONEY)) throw new Error("out of range");
  } catch {
    tendered = null;
    fieldErrors.tendered = "Enter the cash received as a plain amount, for example 5000 or 5000.50 (no commas).";
  }
  if (linesAreSound) {
    let expected: Decimal | null = null;
    try {
      expected = parseMoney(data.expectedTotal);
    } catch {
      expected = null;
    }
    if (!expected || !expected.equals(total)) {
      fieldErrors.expectedTotal = `The total works out to ${formatNaira(total)}, which is not what this screen showed. Reload the page and enter the sale again.`;
    } else if (tendered && tendered.lessThan(total)) {
      fieldErrors.tendered = `The total is ${formatNaira(total)}. The cash received is ${formatNaira(total.minus(tendered))} short.`;
    }
  }

  if (Object.keys(fieldErrors).length > 0 || !terminal || !tendered) {
    throw new ValidationError(NOTHING_SOLD, fieldErrors);
  }
  const cash = tendered;
  const change = cash.minus(total);

  // What each product loses from each location, in base units.
  const perPlace = new Map<string, Map<string, Decimal>>();
  for (const line of checked) {
    const places = perPlace.get(line.productId) ?? new Map<string, Decimal>();
    places.set(line.location.id, (places.get(line.location.id) ?? new Decimal(0)).plus(line.baseQuantity));
    perPlace.set(line.productId, places);
  }
  // Always in the same order (product, then location), so two sales cannot block each other.
  const productOrder = [...perPlace.keys()].sort();
  const locationName = new Map(locations.map((location) => [location.id, location.name]));

  const save = () =>
    db.$transaction(
      async (tx) => {
        // The terminal's next number. Taking it also makes sales from one terminal queue up.
        const counter = await tx.terminal.update({
          where: { id: terminal.id },
          data: { nextReceiptNumber: { increment: 1 } },
          select: { nextReceiptNumber: true },
        });
        const sequence = counter.nextReceiptNumber - 1;
        const receiptNumber = saleReceiptNumber(terminal.code, sequence);

        // The tax rate at this moment; it is copied onto the sale and never looked up again.
        const business = await tx.business.findFirst({ select: { taxRatePercent: true } });
        const rate = new Decimal(business?.taxRatePercent.toFixed(2) ?? "0");

        const short: Record<string, string> = {};
        const costOf = new Map<string, Decimal>();
        for (const productId of productOrder) {
          // The product's "turn", as for every other stock change; its average cost is read here.
          const product = await tx.product.update({
            where: { id: productId },
            data: { updatedAt: new Date() },
            select: { averageCost: true },
          });
          costOf.set(productId, new Decimal(product.averageCost.toFixed(4)));

          const places = [...perPlace.get(productId)!.entries()].sort(([a], [b]) => a.localeCompare(b));
          for (const [locationId, quantity] of places) {
            // Taken out only if that much is there — one statement, so two cashiers can never
            // both sell the last one.
            const needed = quantityToString(quantity);
            const lowered = await tx.stockBalance.updateMany({
              where: { productId, locationId, quantity: { gte: needed } },
              data: { quantity: { decrement: needed } },
            });
            if (lowered.count === 1) continue;
            const there = await tx.stockBalance.findFirst({ where: { productId, locationId }, select: { quantity: true } });
            for (const line of checked) {
              if (line.productId !== productId || line.location.id !== locationId) continue;
              short[`lines.${line.index}.quantity`] =
                `Only ${plainNumber(there?.quantity.toFixed(3) ?? "0")} ${line.baseUnitName} of "${line.productName}" is in ` +
                `${locationName.get(locationId)}. This sale needs ${plainNumber(needed)} ${line.baseUnitName}.`;
            }
          }
        }
        // Throwing here undoes everything above, including the products that had enough.
        if (Object.keys(short).length > 0) {
          throw new ValidationError("Nothing was sold: there is not enough stock.", short);
        }

        const lines = checked.map((line, position) => {
          const lineRate = line.taxable ? rate : new Decimal(0);
          const baseUnitCost = costOf.get(line.productId)!;
          return {
            line,
            lineNumber: position + 1,
            taxRatePercent: lineRate,
            taxAmount: taxIncludedIn(line.lineTotal, lineRate),
            baseUnitCost,
            lineCost: roundMoney(line.baseQuantity.times(baseUnitCost)),
          };
        });

        const sale = await tx.sale.create({
          data: {
            businessId,
            requestId: data.requestId,
            terminalId: terminal.id,
            terminalCode: terminal.code,
            sequence,
            receiptNumber,
            total: moneyToString(total),
            taxRatePercent: rate.toFixed(2),
            taxTotal: moneyToString(sumMoney(lines.map((entry) => entry.taxAmount))),
            costTotal: moneyToString(sumMoney(lines.map((entry) => entry.lineCost))),
            cashierUserId: context.actor.userId,
            cashierName: context.actor.name,
            deviceTime: data.deviceTime ? new Date(data.deviceTime) : null,
          },
        });
        await tx.saleLine.createMany({
          data: lines.map(({ line, ...extra }) => ({
            businessId,
            saleId: sale.id,
            lineNumber: extra.lineNumber,
            productId: line.productId,
            productUnitId: line.productUnitId,
            productName: line.productName,
            unitName: line.unitName,
            unitFactor: line.unitFactor,
            quantity: line.quantity,
            baseQuantity: quantityToString(line.baseQuantity),
            unitPrice: moneyToString(line.unitPrice),
            lineTotal: moneyToString(line.lineTotal),
            taxable: line.taxable,
            taxRatePercent: extra.taxRatePercent.toFixed(2),
            taxAmount: moneyToString(extra.taxAmount),
            baseUnitCost: extra.baseUnitCost.toFixed(4),
            lineCost: moneyToString(extra.lineCost),
            locationId: line.location.id,
            locationName: line.location.name,
          })),
        });
        await tx.stockMovement.createMany({
          data: checked.map((line) => ({
            businessId,
            productId: line.productId,
            locationId: line.location.id,
            type: "SALE" as const,
            quantityDelta: `-${quantityToString(line.baseQuantity)}`,
            unitName: line.unitName,
            unitFactor: line.unitFactor,
            unitQuantity: `-${line.quantity}`,
            documentType: "sale",
            documentId: sale.id,
            documentNumber: receiptNumber,
            userId: context.actor.userId,
            userName: context.actor.name,
          })),
        });
        // The payment is written last: if it cannot be saved, nothing of the sale is.
        if (total.greaterThan(0)) {
          await tx.payment.create({
            data: {
              businessId,
              saleId: sale.id,
              method: "CASH",
              amount: moneyToString(total),
              tendered: moneyToString(cash),
              changeGiven: moneyToString(change),
              receivedByUserId: context.actor.userId,
              receivedByName: context.actor.name,
            },
          });
        }

        return {
          id: sale.id,
          receiptNumber,
          total: moneyToString(total),
          tendered: moneyToString(cash),
          change: moneyToString(change),
          alreadySaved: false,
        };
      },
      { isolationLevel: "ReadCommitted", timeout: 20_000 },
    );

  for (let attempt = 1; ; attempt++) {
    try {
      return await save();
    } catch (error) {
      const known = error instanceof Prisma.PrismaClientKnownRequestError ? error.code : null;
      // The same sale arrived twice at the same moment: return the one that was saved.
      if (known === "P2002") {
        const saved = await alreadySaved();
        if (saved) return saved;
      }
      // Two savers blocked each other and the database undid this one completely: try again.
      if (known === "P2034" && attempt < MAX_ATTEMPTS) continue;
      throw error;
    }
  }
}

// ---------------------------------------------------------------------------
// Sales: list, detail, and the record of receipt prints
// ---------------------------------------------------------------------------

/** Those who may see the sales report see every sale; a cashier sees only their own. */
function ownOnly(context: AppContext): Prisma.SaleWhereInput {
  return can(context, "report.sales.view") ? {} : { cashierUserId: context.actor.userId };
}

export type SaleSummary = {
  id: string;
  receiptNumber: string;
  createdAt: Date;
  cashierName: string;
  lineCount: number;
  /** The first few products, for recognising the sale in the list. */
  products: string[];
  total: string;
};

const dayFilter = z
  .string()
  .trim()
  .optional()
  .default("")
  .transform((value) => (shopDayStart(value) ? value : ""));

const listSchema = z.object({
  search: z.string().trim().max(120).optional().default(""),
  from: dayFilter,
  to: dayFilter,
  page: pageNumber,
});

/**
 * One page of sales, newest first, with the total of everything that matches.
 * A cashier is shown only their own sales.
 */
export async function listSales(
  context: AppContext,
  input: unknown = {},
): Promise<{ sales: SaleSummary[]; sumOfTotals: string; ownOnly: boolean } & Paged> {
  if (!can(context, "report.sales.view")) authorize(context, "report.ownShift.view");
  const { search, from, to, page } = parseInput(listSchema, input);

  const createdAt: Prisma.DateTimeFilter = {};
  if (from) createdAt.gte = shopDayStart(from)!;
  if (to) createdAt.lte = shopDayEnd(to)!;
  const where: Prisma.SaleWhereInput = {
    ...ownOnly(context),
    ...(from || to ? { createdAt } : {}),
    ...(search
      ? {
          OR: [
            { receiptNumber: { contains: search } },
            { cashierName: { contains: search } },
            { lines: { some: { productName: { contains: search } } } },
          ],
        }
      : {}),
  };
  const db = businessDb(context);
  const [total, sum, rows] = await Promise.all([
    db.sale.count({ where }),
    db.sale.aggregate({ where, _sum: { total: true } }),
    db.sale.findMany({
      where,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
      select: {
        id: true,
        receiptNumber: true,
        createdAt: true,
        cashierName: true,
        total: true,
        lines: { orderBy: { lineNumber: "asc" }, take: 3, select: { productName: true } },
        _count: { select: { lines: true } },
      },
    }),
  ]);
  return {
    ownOnly: !can(context, "report.sales.view"),
    sumOfTotals: (sum._sum.total ?? new Decimal(0)).toFixed(2),
    sales: rows.map((row) => ({
      id: row.id,
      receiptNumber: row.receiptNumber,
      createdAt: row.createdAt,
      cashierName: row.cashierName,
      lineCount: row._count.lines,
      products: row.lines.map((line) => line.productName),
      total: row.total.toFixed(2),
    })),
    ...paged(total, page),
  };
}

export type SaleDetail = {
  id: string;
  receiptNumber: string;
  createdAt: Date;
  cashierName: string;
  terminalCode: string;
  paperWidth: "MM58" | "MM80";
  total: string;
  taxRatePercent: string;
  taxTotal: string;
  /** What the goods cost, and the profit — only for those who may see cost prices. */
  costTotal: string | null;
  tendered: string;
  change: string;
  /** How many times the receipt has been printed so far. */
  printCount: number;
  /** What is printed around the sale: taken from the business's settings as they are now. */
  business: { name: string; receiptHeader: string | null; receiptFooter: string | null; taxNumber: string | null };
  lines: {
    lineNumber: number;
    productName: string;
    unitName: string;
    quantity: string;
    baseQuantity: string;
    unitPrice: string;
    lineTotal: string;
    taxAmount: string;
    locationName: string;
  }[];
};

const saleIdSchema = z.object({ saleId: z.string().uuid("That sale could not be found.") });

/** One sale with everything its receipt shows. A cashier can open only their own sales. */
export async function getSale(context: AppContext, input: unknown): Promise<SaleDetail> {
  if (!can(context, "report.sales.view")) authorize(context, "report.ownShift.view");
  const { saleId } = parseInput(saleIdSchema, input);
  const db = businessDb(context);

  const [row, business] = await Promise.all([
    db.sale.findFirst({
      where: { id: saleId, ...ownOnly(context) },
      include: {
        lines: { orderBy: { lineNumber: "asc" } },
        payments: true,
        terminal: { select: { paperWidth: true } },
        _count: { select: { receiptPrints: true } },
      },
    }),
    db.business.findFirst({ select: { name: true, receiptHeader: true, receiptFooter: true, taxNumber: true } }),
  ]);
  if (!row || !business) throw new NotFoundError("That sale could not be found.");
  const cash = row.payments[0];
  return {
    id: row.id,
    receiptNumber: row.receiptNumber,
    createdAt: row.createdAt,
    cashierName: row.cashierName,
    terminalCode: row.terminalCode,
    paperWidth: row.terminal.paperWidth,
    total: row.total.toFixed(2),
    taxRatePercent: row.taxRatePercent.toFixed(2),
    taxTotal: row.taxTotal.toFixed(2),
    costTotal: can(context, "cost.view") ? row.costTotal.toFixed(2) : null,
    tendered: (cash?.tendered ?? row.total).toFixed(2),
    change: (cash?.changeGiven ?? new Decimal(0)).toFixed(2),
    printCount: row._count.receiptPrints,
    business,
    lines: row.lines.map((line) => ({
      lineNumber: line.lineNumber,
      productName: line.productName,
      unitName: line.unitName,
      quantity: line.quantity.toFixed(3),
      baseQuantity: line.baseQuantity.toFixed(3),
      unitPrice: line.unitPrice.toFixed(2),
      lineTotal: line.lineTotal.toFixed(2),
      taxAmount: line.taxAmount.toFixed(2),
      locationName: line.locationName,
    })),
  };
}

/**
 * Notes that a receipt is being printed. The first print is the original; every later one
 * is a reprint, which is also written to the activity log.
 */
export async function recordReceiptPrint(context: AppContext, input: unknown): Promise<{ reprint: boolean }> {
  if (!can(context, "report.sales.view")) authorize(context, "report.ownShift.view");
  const businessId = businessIdOf(context);
  const { saleId } = parseInput(saleIdSchema, input);
  const db = businessDb(context);

  const sale = await db.sale.findFirst({
    where: { id: saleId, ...ownOnly(context) },
    select: { id: true, receiptNumber: true, _count: { select: { receiptPrints: true } } },
  });
  if (!sale) throw new NotFoundError("That sale could not be found.");
  const reprint = sale._count.receiptPrints > 0;

  await db.$transaction(async (tx) => {
    await tx.saleReceiptPrint.create({
      data: { businessId, saleId: sale.id, printedByUserId: context.actor.userId, printedByName: context.actor.name },
    });
    if (reprint) {
      await tx.activityLog.create({
        data: activityRow(context, {
          action: "sale.receipt_reprinted",
          summary: `${context.actor.name} printed receipt ${sale.receiptNumber} again.`,
          targetType: "sale",
          targetId: sale.id,
        }),
      });
    }
  });
  return { reprint };
}
