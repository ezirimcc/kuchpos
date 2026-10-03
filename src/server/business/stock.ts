import "server-only";
import { z } from "zod";
import { Prisma } from "@/generated/prisma/client";
import { Decimal } from "@/lib/decimal";
import { addMonths, dateToDay, dayToDate, formatDay, receiptNumber, shopToday } from "@/lib/format";
import { formatNaira, lineTotal, moneyToString, movingAverageCost, parseMoney, sumMoney } from "@/lib/money";
import { parseQuantity, quantityToString, toBaseQuantity } from "@/lib/quantity";
import { activityRow } from "@/server/activity";
import type { AppContext } from "@/server/auth/context";
import { parseInput } from "@/server/auth/users";
import { businessDb, businessIdOf } from "@/server/db/scoped";
import { NotFoundError, ValidationError } from "@/server/errors";
import { optionalText } from "@/server/input";
import { PAGE_SIZE, type Paged, paged, pageNumber } from "@/server/paging";
import { authorize, can } from "@/server/permissions";

/**
 * Stock for the business in use: receiving goods, the add-only movement ledger,
 * balances per location, and what is expiring soon.
 *
 * Stock changes ONLY by writing a movement together with the matching balance change,
 * inside one database transaction. Quantities and money travel as exact decimal text.
 */

const MAX_LINES = 200;
const MAX_BACKDATE_DAYS = 366;
const MAX_UNIT_QUANTITY = new Decimal("9999999.999");
const MAX_BASE_QUANTITY = new Decimal("999999999.999");
const MAX_UNIT_COST = new Decimal("999999999.99");

// ---------------------------------------------------------------------------
// What the "receive goods" screen needs
// ---------------------------------------------------------------------------

export type ReceivingProduct = {
  id: string;
  name: string;
  code: string | null;
  allowsFraction: boolean;
  tracksBatch: boolean;
  tracksExpiry: boolean;
  baseUnitName: string;
  /** Units this product can be bought in, smallest first. */
  units: { id: string; name: string; factor: string; isBase: boolean }[];
};

export type ReceivingOptions = {
  today: string;
  canBackdate: boolean;
  suppliers: { id: string; name: string }[];
  locations: { id: string; name: string; kind: "SHELF" | "STOREROOM" }[];
  products: ReceivingProduct[];
};

export async function getReceivingOptions(context: AppContext): Promise<ReceivingOptions> {
  authorize(context, "stock.receive");
  const db = businessDb(context);
  const [suppliers, locations, products] = await Promise.all([
    db.supplier.findMany({ where: { deactivatedAt: null }, orderBy: { name: "asc" }, select: { id: true, name: true } }),
    db.location.findMany({ orderBy: { kind: "desc" }, select: { id: true, name: true, kind: true } }),
    db.product.findMany({
      where: { deactivatedAt: null },
      orderBy: { name: "asc" },
      select: {
        id: true,
        name: true,
        code: true,
        allowsFraction: true,
        tracksBatch: true,
        tracksExpiry: true,
        units: {
          where: { retiredAt: null, forPurchase: true },
          orderBy: { factor: "asc" },
          select: { id: true, name: true, factor: true, isBase: true },
        },
      },
    }),
  ]);
  const baseNames = new Map(
    (
      await db.productUnit.findMany({ where: { isBase: true }, select: { productId: true, name: true } })
    ).map((unit) => [unit.productId, unit.name]),
  );
  return {
    today: shopToday(),
    canBackdate: can(context, "stock.receive.backdate"),
    suppliers,
    locations,
    products: products
      .filter((product) => product.units.length > 0)
      .map((product) => ({
        id: product.id,
        name: product.name,
        code: product.code,
        allowsFraction: product.allowsFraction,
        tracksBatch: product.tracksBatch,
        tracksExpiry: product.tracksExpiry,
        baseUnitName: baseNames.get(product.id) ?? "",
        units: product.units.map((unit) => ({
          id: unit.id,
          name: unit.name,
          factor: unit.factor.toFixed(3),
          isBase: unit.isBase,
        })),
      })),
  };
}

// ---------------------------------------------------------------------------
// Receiving goods
// ---------------------------------------------------------------------------

const lineSchema = z.object({
  productId: z.string().trim(),
  unitId: z.string().trim(),
  quantity: z.string().trim(),
  unitCost: z.string().trim(),
  batchNumber: optionalText(60, "The batch number is too long (60 characters at most).").optional().default(""),
  expiryDate: z.string().trim().optional().default(""),
});

const receiveSchema = z.object({
  requestId: z.string().uuid("This form has expired. Reload the page and enter the delivery again."),
  supplierId: z.string().uuid("Choose the supplier."),
  locationId: z.string().uuid("Choose where the goods are going."),
  /** Blank means today. */
  receivedOn: z.string().trim().optional().default(""),
  backdateNote: optionalText(300, "The note is too long (300 characters at most).").optional().default(""),
  invoiceNumber: optionalText(60, "The invoice number is too long (60 characters at most).").optional().default(""),
  note: optionalText(300, "The note is too long (300 characters at most).").optional().default(""),
  lines: z
    .array(lineSchema)
    .min(1, "Add at least one product to the delivery.")
    .max(MAX_LINES, `A delivery can have at most ${MAX_LINES} lines. Split it into two deliveries.`),
});

export type ReceiveResult = { id: string; number: number; alreadySaved: boolean };

type CheckedLine = {
  productId: string;
  productUnitId: string;
  productName: string;
  unitName: string;
  unitFactor: string;
  quantity: string;
  baseQuantity: Decimal;
  unitCost: string;
  lineCost: Decimal;
  batchNumber: string | null;
  expiryDate: Date | null;
};

function daysBetween(earlier: string, later: string): number {
  return Math.round((dayToDate(later)!.getTime() - dayToDate(earlier)!.getTime()) / 86_400_000);
}

/**
 * Records a delivery from a supplier: the document, its lines, the stock movements, the new
 * balances and the new average costs — all of it, or none of it.
 *
 * `requestId` is made up by the browser; sending the same one again returns the delivery
 * that was already saved and changes nothing.
 */
export async function receiveGoods(context: AppContext, input: unknown): Promise<ReceiveResult> {
  authorize(context, "stock.receive");
  const businessId = businessIdOf(context);
  const data = parseInput(receiveSchema, input);
  const db = businessDb(context);

  const existing = await db.goodsReceipt.findFirst({
    where: { requestId: data.requestId },
    select: { id: true, number: true },
  });
  if (existing) return { ...existing, alreadySaved: true };

  const fieldErrors: Record<string, string> = {};

  // --- The date --------------------------------------------------------------------
  const today = shopToday();
  const receivedOn = data.receivedOn === "" ? today : data.receivedOn;
  const receivedDate = dayToDate(receivedOn);
  let backdated = false;
  if (!receivedDate) {
    fieldErrors.receivedOn = "Enter a real date.";
  } else if (receivedOn > today) {
    fieldErrors.receivedOn = "A delivery cannot be dated in the future.";
  } else if (receivedOn < today) {
    backdated = true;
    if (!can(context, "stock.receive.backdate")) {
      fieldErrors.receivedOn = "Only a manager or admin can give a delivery an earlier date.";
    } else if (daysBetween(receivedOn, today) > MAX_BACKDATE_DAYS) {
      fieldErrors.receivedOn = "That date is more than a year ago. Check the year.";
    } else if (!data.backdateNote || data.backdateNote.length < 5) {
      fieldErrors.backdateNote = "Explain why this delivery is being entered with an earlier date.";
    }
  }

  // --- Supplier and location -------------------------------------------------------
  const [supplier, location] = await Promise.all([
    db.supplier.findFirst({ where: { id: data.supplierId }, select: { id: true, name: true, deactivatedAt: true } }),
    db.location.findFirst({ where: { id: data.locationId }, select: { id: true, name: true } }),
  ]);
  if (!supplier) fieldErrors.supplierId = "Choose the supplier.";
  else if (supplier.deactivatedAt) fieldErrors.supplierId = "This supplier is out of use. Choose another, or bring it back first.";
  if (!location) fieldErrors.locationId = "Choose where the goods are going.";

  // --- The lines -------------------------------------------------------------------
  const productIds = [...new Set(data.lines.map((line) => line.productId).filter(Boolean))];
  const products = await db.product.findMany({
    where: { id: { in: productIds } },
    select: {
      id: true,
      name: true,
      allowsFraction: true,
      tracksBatch: true,
      tracksExpiry: true,
      deactivatedAt: true,
      units: { select: { id: true, name: true, factor: true, forPurchase: true, retiredAt: true } },
    },
  });
  const productById = new Map(products.map((product) => [product.id, product]));

  const checked: CheckedLine[] = [];
  data.lines.forEach((line, index) => {
    const at = (field: string) => `lines.${index}.${field}`;
    const product = productById.get(line.productId);
    if (!product) {
      fieldErrors[at("productId")] = "Choose a product.";
      return;
    }
    if (product.deactivatedAt) {
      fieldErrors[at("productId")] = `"${product.name}" is out of use and cannot be received.`;
      return;
    }
    const unit = product.units.find((candidate) => candidate.id === line.unitId);
    if (!unit || unit.retiredAt || !unit.forPurchase) {
      fieldErrors[at("unitId")] = "Choose a unit this product is bought in.";
      return;
    }

    let quantity: Decimal | null = null;
    let baseQuantity: Decimal | null = null;
    try {
      quantity = parseQuantity(line.quantity);
      if (!quantity.greaterThan(0) || quantity.greaterThan(MAX_UNIT_QUANTITY)) throw new Error("out of range");
      if (!product.allowsFraction && !quantity.isInteger()) {
        fieldErrors[at("quantity")] = `"${product.name}" comes in whole units only. Enter a whole number.`;
        quantity = null;
      } else {
        baseQuantity = toBaseQuantity(quantity, new Decimal(unit.factor.toFixed(3)));
        if (baseQuantity.greaterThan(MAX_BASE_QUANTITY)) throw new Error("too large");
      }
    } catch {
      fieldErrors[at("quantity")] ??= "Enter how many arrived, as a number greater than zero (up to 3 decimal places).";
      quantity = null;
    }

    let unitCost: Decimal | null = null;
    try {
      unitCost = parseMoney(line.unitCost);
      if (unitCost.isNegative() || unitCost.greaterThan(MAX_UNIT_COST)) throw new Error("out of range");
    } catch {
      fieldErrors[at("unitCost")] = "Enter the cost of one unit as a plain amount, for example 4200 or 4200.50 (no commas).";
      unitCost = null;
    }

    const batchNumber = line.batchNumber || null;
    if (product.tracksBatch && !batchNumber) {
      fieldErrors[at("batchNumber")] = `"${product.name}" needs a batch number.`;
    } else if (!product.tracksBatch && batchNumber) {
      fieldErrors[at("batchNumber")] = `"${product.name}" is not set up to use batch numbers.`;
    }

    let expiryDate: Date | null = null;
    if (product.tracksExpiry) {
      expiryDate = dayToDate(line.expiryDate);
      if (!expiryDate) fieldErrors[at("expiryDate")] = `"${product.name}" needs an expiry date.`;
    } else if (line.expiryDate !== "") {
      fieldErrors[at("expiryDate")] = `"${product.name}" is not set up to use expiry dates.`;
    }

    if (quantity && baseQuantity && unitCost) {
      checked.push({
        productId: product.id,
        productUnitId: unit.id,
        productName: product.name,
        unitName: unit.name,
        unitFactor: unit.factor.toFixed(3),
        quantity: quantityToString(quantity),
        baseQuantity,
        unitCost: moneyToString(unitCost),
        lineCost: lineTotal(quantity, unitCost),
        batchNumber,
        expiryDate,
      });
    }
  });

  if (Object.keys(fieldErrors).length > 0 || !supplier || !location || !receivedDate) {
    throw new ValidationError("Nothing was saved. Please correct the highlighted fields.", fieldErrors);
  }

  const totalCost = sumMoney(checked.map((line) => line.lineCost));

  // What each product gains in this delivery, in base units and in cost.
  const perProduct = new Map<string, { quantity: Decimal; cost: Decimal }>();
  for (const line of checked) {
    const sum = perProduct.get(line.productId) ?? { quantity: new Decimal(0), cost: new Decimal(0) };
    perProduct.set(line.productId, {
      quantity: sum.quantity.plus(line.baseQuantity),
      cost: sum.cost.plus(line.lineCost),
    });
  }
  // Always in the same order, so two deliveries saved at the same moment cannot block each other.
  const productOrder = [...perProduct.keys()].sort();

  try {
    return await db.$transaction(
      async (tx) => {
        const counter = await tx.business.update({
          where: { id: businessId },
          data: { nextGoodsReceiptNumber: { increment: 1 } },
          select: { nextGoodsReceiptNumber: true },
        });
        const number = counter.nextGoodsReceiptNumber - 1;

        const receipt = await tx.goodsReceipt.create({
          data: {
            businessId,
            requestId: data.requestId,
            number,
            supplierId: supplier.id,
            supplierName: supplier.name,
            locationId: location.id,
            locationName: location.name,
            receivedOn: receivedDate,
            backdated,
            backdateNote: backdated ? data.backdateNote : null,
            invoiceNumber: data.invoiceNumber || null,
            note: data.note || null,
            totalCost: moneyToString(totalCost),
            createdByUserId: context.actor.userId,
            createdByName: context.actor.name,
          },
        });

        await tx.goodsReceiptLine.createMany({
          data: checked.map((line, index) => ({
            businessId,
            receiptId: receipt.id,
            lineNumber: index + 1,
            productId: line.productId,
            productUnitId: line.productUnitId,
            productName: line.productName,
            unitName: line.unitName,
            unitFactor: line.unitFactor,
            quantity: line.quantity,
            baseQuantity: quantityToString(line.baseQuantity),
            unitCost: line.unitCost,
            lineCost: moneyToString(line.lineCost),
            batchNumber: line.batchNumber,
            expiryDate: line.expiryDate,
          })),
        });

        for (const productId of productOrder) {
          const added = perProduct.get(productId)!;
          // Touching the product row makes any other delivery of the same product wait its turn,
          // so the stock total read on the next line is the true total.
          const product = await tx.product.update({
            where: { id: productId },
            data: { updatedAt: new Date() },
            select: { averageCost: true },
          });
          const before = await tx.stockBalance.aggregate({ where: { productId }, _sum: { quantity: true } });
          const average = movingAverageCost({
            quantityBefore: new Decimal(before._sum.quantity?.toFixed(3) ?? "0"),
            averageBefore: new Decimal(product.averageCost.toFixed(4)),
            quantityAdded: added.quantity,
            costAdded: added.cost,
          });
          await tx.product.update({ where: { id: productId }, data: { averageCost: average.toFixed(4) } });

          const increased = await tx.stockBalance.updateMany({
            where: { productId, locationId: location.id },
            data: { quantity: { increment: quantityToString(added.quantity) } },
          });
          if (increased.count === 0) {
            await tx.stockBalance.create({
              data: { businessId, productId, locationId: location.id, quantity: quantityToString(added.quantity) },
            });
          }
        }

        await tx.stockMovement.createMany({
          data: checked.map((line) => ({
            businessId,
            productId: line.productId,
            locationId: location.id,
            type: "RECEIPT" as const,
            quantityDelta: quantityToString(line.baseQuantity),
            unitName: line.unitName,
            unitFactor: line.unitFactor,
            unitQuantity: line.quantity,
            documentType: "goods_receipt",
            documentId: receipt.id,
            documentNumber: receiptNumber(number),
            userId: context.actor.userId,
            userName: context.actor.name,
          })),
        });

        await tx.activityLog.create({
          data: activityRow(context, {
            action: backdated ? "stock.received_backdated" : "stock.received",
            summary:
              `${context.actor.name} recorded delivery ${receiptNumber(number)} from ${supplier.name} into ${location.name}: ` +
              `${checked.length} line${checked.length === 1 ? "" : "s"}, ${formatNaira(totalCost)}.` +
              (backdated ? ` BACKDATED to ${formatDay(receivedOn)} — reason: ${data.backdateNote}` : ""),
            targetType: "goods_receipt",
            targetId: receipt.id,
            details: { number, receivedOn, backdated, lines: checked.length, totalCost: moneyToString(totalCost) },
          }),
        });

        return { id: receipt.id, number, alreadySaved: false };
      },
      // Each statement sees the latest saved data, so the stock total read after taking the
      // product's turn includes any delivery that finished a moment earlier.
      { isolationLevel: "ReadCommitted", timeout: 20_000 },
    );
  } catch (error) {
    // The same submission arrived twice at the same moment: return the one that was saved.
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      const saved = await db.goodsReceipt.findFirst({
        where: { requestId: data.requestId },
        select: { id: true, number: true },
      });
      if (saved) return { ...saved, alreadySaved: true };
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Deliveries: list and detail
// ---------------------------------------------------------------------------

export type ReceiptSummary = {
  id: string;
  number: number;
  receivedOn: string;
  supplierName: string;
  locationName: string;
  lineCount: number;
  totalCost: string;
  backdated: boolean;
  createdByName: string;
  createdAt: Date;
};

const dayFilter = z
  .string()
  .trim()
  .optional()
  .default("")
  .transform((value) => (dayToDate(value) ? value : ""));

const listReceiptsSchema = z.object({
  search: z.string().trim().max(120).optional().default(""),
  from: dayFilter,
  to: dayFilter,
  page: pageNumber,
});

/** One page of deliveries, newest first. Filter by supplier/invoice words, delivery number, or date range. */
export async function listReceipts(context: AppContext, input: unknown = {}): Promise<{ receipts: ReceiptSummary[] } & Paged> {
  authorize(context, "stock.receipts.view");
  const { search, from, to, page } = parseInput(listReceiptsSchema, input);

  const receivedOn: Prisma.DateTimeFilter = {};
  if (from) receivedOn.gte = dayToDate(from)!;
  if (to) receivedOn.lte = dayToDate(to)!;
  const numberSearch = /^(?:gr-?)?0*(\d{1,9})$/i.exec(search)?.[1];

  const where: Prisma.GoodsReceiptWhereInput = {
    ...(from || to ? { receivedOn } : {}),
    ...(search
      ? {
          OR: [
            { supplierName: { contains: search } },
            { invoiceNumber: { contains: search } },
            { lines: { some: { productName: { contains: search } } } },
            ...(numberSearch ? [{ number: Number.parseInt(numberSearch, 10) }] : []),
          ],
        }
      : {}),
  };
  const db = businessDb(context);
  const [total, rows] = await Promise.all([
    db.goodsReceipt.count({ where }),
    db.goodsReceipt.findMany({
      where,
      orderBy: [{ number: "desc" }],
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
      select: {
        id: true,
        number: true,
        receivedOn: true,
        supplierName: true,
        locationName: true,
        totalCost: true,
        backdated: true,
        createdByName: true,
        createdAt: true,
        _count: { select: { lines: true } },
      },
    }),
  ]);
  return {
    receipts: rows.map((row) => ({
      id: row.id,
      number: row.number,
      receivedOn: dateToDay(row.receivedOn),
      supplierName: row.supplierName,
      locationName: row.locationName,
      lineCount: row._count.lines,
      totalCost: row.totalCost.toFixed(2),
      backdated: row.backdated,
      createdByName: row.createdByName,
      createdAt: row.createdAt,
    })),
    ...paged(total, page),
  };
}

export type ReceiptDetail = ReceiptSummary & {
  backdateNote: string | null;
  invoiceNumber: string | null;
  note: string | null;
  lines: {
    lineNumber: number;
    productId: string;
    productName: string;
    unitName: string;
    unitFactor: string;
    quantity: string;
    baseQuantity: string;
    unitCost: string;
    lineCost: string;
    batchNumber: string | null;
    expiryDate: string | null;
  }[];
};

export async function getReceipt(context: AppContext, input: unknown): Promise<ReceiptDetail> {
  authorize(context, "stock.receipts.view");
  const { receiptId } = parseInput(z.object({ receiptId: z.string().uuid("That delivery could not be found.") }), input);

  const row = await businessDb(context).goodsReceipt.findFirst({
    where: { id: receiptId },
    include: { lines: { orderBy: { lineNumber: "asc" } } },
  });
  if (!row) throw new NotFoundError("That delivery could not be found.");
  return {
    id: row.id,
    number: row.number,
    receivedOn: dateToDay(row.receivedOn),
    supplierName: row.supplierName,
    locationName: row.locationName,
    lineCount: row.lines.length,
    totalCost: row.totalCost.toFixed(2),
    backdated: row.backdated,
    backdateNote: row.backdateNote,
    invoiceNumber: row.invoiceNumber,
    note: row.note,
    createdByName: row.createdByName,
    createdAt: row.createdAt,
    lines: row.lines.map((line) => ({
      lineNumber: line.lineNumber,
      productId: line.productId,
      productName: line.productName,
      unitName: line.unitName,
      unitFactor: line.unitFactor.toFixed(3),
      quantity: line.quantity.toFixed(3),
      baseQuantity: line.baseQuantity.toFixed(3),
      unitCost: line.unitCost.toFixed(2),
      lineCost: line.lineCost.toFixed(2),
      batchNumber: line.batchNumber,
      expiryDate: line.expiryDate ? dateToDay(line.expiryDate) : null,
    })),
  };
}

// ---------------------------------------------------------------------------
// Stock on hand
// ---------------------------------------------------------------------------

export type StockOnHandRow = {
  productId: string;
  productName: string;
  code: string | null;
  category: string | null;
  baseUnitName: string;
  /** In-use units, for showing a quantity as "2 carton + 5 single". */
  units: { name: string; factor: string }[];
  /** Quantity in base units per location id (missing means none), and in total. */
  byLocation: Record<string, string>;
  total: string;
};

const stockOnHandSchema = z.object({
  search: z.string().trim().max(120).optional().default(""),
  category: z.string().trim().max(40).optional().default(""),
  /** "1" to show only products that have stock somewhere. */
  inStock: z.string().optional().default(""),
  page: pageNumber,
});

/** One page of products with how much of each is in every location. Everyone in the business may look. */
export async function listStockOnHand(
  context: AppContext,
  input: unknown = {},
): Promise<{ rows: StockOnHandRow[]; locations: { id: string; name: string }[] } & Paged> {
  authorize(context, "stock.view");
  const { search, category, inStock, page } = parseInput(stockOnHandSchema, input);
  const db = businessDb(context);

  const where: Prisma.ProductWhereInput = {
    deactivatedAt: null,
    ...(category === "none" ? { categoryId: null } : category ? { categoryId: category } : {}),
    ...(search ? { OR: [{ name: { contains: search } }, { code: { contains: search } }, { barcode: search }] } : {}),
    ...(inStock === "1" ? { stockBalances: { some: { quantity: { gt: 0 } } } } : {}),
  };
  const [total, products, locations] = await Promise.all([
    db.product.count({ where }),
    db.product.findMany({
      where,
      orderBy: [{ name: "asc" }, { id: "asc" }],
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
      select: {
        id: true,
        name: true,
        code: true,
        category: { select: { name: true } },
        units: { where: { retiredAt: null }, select: { name: true, factor: true, isBase: true } },
        stockBalances: { select: { locationId: true, quantity: true } },
      },
    }),
    db.location.findMany({ orderBy: { kind: "asc" }, select: { id: true, name: true } }),
  ]);

  return {
    locations,
    rows: products.map((product) => {
      const byLocation: Record<string, string> = {};
      let sum = new Decimal(0);
      for (const balance of product.stockBalances) {
        byLocation[balance.locationId] = balance.quantity.toFixed(3);
        sum = sum.plus(balance.quantity.toFixed(3));
      }
      return {
        productId: product.id,
        productName: product.name,
        code: product.code,
        category: product.category?.name ?? null,
        baseUnitName: product.units.find((unit) => unit.isBase)?.name ?? "",
        units: product.units.map((unit) => ({ name: unit.name, factor: unit.factor.toFixed(3) })),
        byLocation,
        total: quantityToString(sum),
      };
    }),
    ...paged(total, page),
  };
}

// ---------------------------------------------------------------------------
// Expiring soon
// ---------------------------------------------------------------------------

export type ExpiringRow = {
  receiptId: string;
  receiptNumber: number;
  receivedOn: string;
  productId: string;
  productName: string;
  batchNumber: string | null;
  expiryDate: string;
  /** True when the date has already passed. */
  expired: boolean;
  quantity: string;
  unitName: string;
  /** How much of the product the business holds now, in base units (not split by batch). */
  stockNow: string;
  baseUnitName: string;
};

/**
 * Delivered goods whose expiry date falls within the business's "expiring soon" period
 * (or has already passed), for products that still have stock. Soonest first.
 *
 * Stock is not tracked per batch, so this lists the deliveries to check on the shelf;
 * it cannot say how much of a particular batch is left.
 */
export async function listExpiringSoon(
  context: AppContext,
  input: unknown = {},
): Promise<{ rows: ExpiringRow[]; months: number; until: string } & Paged> {
  authorize(context, "report.stock.view");
  const { page } = parseInput(z.object({ page: pageNumber }), input);
  const db = businessDb(context);

  const business = await db.business.findFirst({ select: { expiringSoonMonths: true } });
  const months = business?.expiringSoonMonths ?? 3;
  const today = shopToday();
  const until = addMonths(today, months);

  const where: Prisma.GoodsReceiptLineWhereInput = {
    expiryDate: { not: null, lte: dayToDate(until)! },
    product: { deactivatedAt: null, stockBalances: { some: { quantity: { gt: 0 } } } },
  };
  const [total, lines] = await Promise.all([
    db.goodsReceiptLine.count({ where }),
    db.goodsReceiptLine.findMany({
      where,
      orderBy: [{ expiryDate: "asc" }, { id: "asc" }],
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
      select: {
        productId: true,
        productName: true,
        batchNumber: true,
        expiryDate: true,
        quantity: true,
        unitName: true,
        receipt: { select: { id: true, number: true, receivedOn: true } },
        product: {
          select: {
            name: true,
            units: { where: { isBase: true }, select: { name: true } },
            stockBalances: { select: { quantity: true } },
          },
        },
      },
    }),
  ]);

  return {
    months,
    until,
    rows: lines.map((line) => {
      const expiryDate = dateToDay(line.expiryDate!);
      const stockNow = line.product.stockBalances.reduce(
        (sum, balance) => sum.plus(balance.quantity.toFixed(3)),
        new Decimal(0),
      );
      return {
        receiptId: line.receipt.id,
        receiptNumber: line.receipt.number,
        receivedOn: dateToDay(line.receipt.receivedOn),
        productId: line.productId,
        productName: line.product.name,
        batchNumber: line.batchNumber,
        expiryDate,
        expired: expiryDate < today,
        quantity: line.quantity.toFixed(3),
        unitName: line.unitName,
        stockNow: quantityToString(stockNow),
        baseUnitName: line.product.units[0]?.name ?? "",
      };
    }),
    ...paged(total, page),
  };
}
