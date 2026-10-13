import "server-only";
import { z } from "zod";
import { Prisma } from "@/generated/prisma/client";
import { Decimal } from "@/lib/decimal";
import { addMonths, dateToDay, dayToDate, shopToday } from "@/lib/format";
import { quantityToString } from "@/lib/quantity";
import type { AppContext } from "@/server/auth/context";
import { parseInput } from "@/server/auth/users";
import { businessDb } from "@/server/db/scoped";
import { NotFoundError, ValidationError } from "@/server/errors";
import { optionalText } from "@/server/input";
import { PAGE_SIZE, type Paged, paged, pageNumber } from "@/server/paging";
import { EXPIRY_MONTH_CHOICES } from "@/lib/expiry";
import { authorize, can } from "@/server/permissions";
import { type CheckedLine, checkLines, lineSchema, MAX_LINES } from "@/server/receipt-lines";
import { writeGoodsReceipt } from "@/server/receipt-write";

/**
 * Stock for the business in use: receiving goods, the add-only movement ledger,
 * balances per location, and what is expiring soon.
 *
 * Stock changes ONLY by writing a movement together with the matching balance change,
 * inside one database transaction. Correcting a saved delivery is in receipt-corrections.ts. Quantities and money travel as exact decimal text.
 */

const MAX_BACKDATE_DAYS = 366;
/** How many times to try again when the database reports that two savers got in each other's way. */
const MAX_ATTEMPTS = 3;

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
  const results = await checkLines(db, data.lines, fieldErrors);
  const checked = results.filter((line): line is CheckedLine => line !== null);

  if (Object.keys(fieldErrors).length > 0 || !supplier || !location || !receivedDate) {
    throw new ValidationError("Nothing was saved. Please correct the highlighted fields.", fieldErrors);
  }

  const save = () =>
    db.$transaction(
      async (tx) => {
        const saved = await writeGoodsReceipt(tx, context, {
          requestId: data.requestId,
          supplier,
          location,
          receivedOn,
          backdated,
          backdateNote: backdated ? data.backdateNote || null : null,
          invoiceNumber: data.invoiceNumber || null,
          note: data.note || null,
          lines: checked,
        });
        return { ...saved, alreadySaved: false };
      },
      // Each statement sees the latest saved data, so the stock total read after taking the
      // product's turn includes any delivery that finished a moment earlier.
      { isolationLevel: "ReadCommitted", timeout: 20_000 },
    );

  for (let attempt = 1; ; attempt++) {
    try {
      return await save();
    } catch (error) {
      const known = error instanceof Prisma.PrismaClientKnownRequestError ? error.code : null;
      // The same submission arrived twice at the same moment: return the one that was saved.
      if (known === "P2002") {
        const saved = await db.goodsReceipt.findFirst({
          where: { requestId: data.requestId },
          select: { id: true, number: true },
        });
        if (saved) return { ...saved, alreadySaved: true };
      }
      // Two savers blocked each other and the database undid this one completely: try again.
      if (known === "P2034" && attempt < MAX_ATTEMPTS) continue;
      throw error;
    }
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
  /** 1 for a delivery as first saved; higher once it has been corrected. */
  version: number;
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
        version: true,
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
      version: row.version,
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
    version: row.version,
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
  /** True when it expires within the business's own "expiring soon" period (or has expired): shown in red. */
  soon: boolean;
  /** Whole months from today until it expires; 0 once it has under a month left or has expired. */
  monthsLeft: number;
  /** What was DELIVERED in this batch — not what is left of it (stock is not counted batch by batch). */
  quantity: string;
  unitName: string;
  /** What that delivery line cost; null for those who do not see delivery costs. */
  value: string | null;
  /** How much of the product the business holds now, in base units (not split by batch). */
  stockNow: string;
  baseUnitName: string;
};

const EXPIRY_SORTS = ["expiry", "quantity", "value"] as const;
export type ExpirySort = (typeof EXPIRY_SORTS)[number];

const expiringSchema = z.object({
  /** Part of a product's name or of a batch number. */
  search: z.string().trim().max(120).optional().default(""),
  /** How many months ahead to look; empty for the business's own setting. */
  months: z.string().trim().optional().default(""),
  sort: z.string().trim().optional().default("expiry"),
  page: pageNumber,
});

/**
 * Delivered goods whose expiry date falls within the months asked for (the business's own
 * "expiring soon" period unless another is chosen) or has already passed, for products that
 * still have stock. Soonest first, or the largest quantity or value first.
 *
 * Batch number and expiry date are recorded on each delivery line, but stock is not counted
 * separately per batch. So the quantity and value here are what was delivered in the batch,
 * and the list says which batches to look for on the shelf, not how much of each is left.
 */
export async function listExpiringSoon(
  context: AppContext,
  input: unknown = {},
): Promise<{ rows: ExpiringRow[]; months: number; usualMonths: number; until: string; sort: ExpirySort; showsValue: boolean } & Paged> {
  authorize(context, "report.stock.view");
  const data = parseInput(expiringSchema, input);
  const page = data.page;
  const db = businessDb(context);

  const business = await db.business.findFirst({ select: { expiringSoonMonths: true } });
  const usualMonths = business?.expiringSoonMonths ?? 3;
  const asked = Number.parseInt(data.months, 10);
  const months = (EXPIRY_MONTH_CHOICES as readonly number[]).includes(asked) ? asked : usualMonths;
  const sort = (EXPIRY_SORTS as readonly string[]).includes(data.sort) ? (data.sort as ExpirySort) : "expiry";
  const today = shopToday();
  const until = addMonths(today, months);
  const soonUntil = addMonths(today, usualMonths);
  // The cost of a delivery is for those who may see deliveries with their costs (C36).
  const showsValue = can(context, "stock.receipts.view");

  const where: Prisma.GoodsReceiptLineWhereInput = {
    expiryDate: { not: null, lte: dayToDate(until)! },
    product: { deactivatedAt: null, stockBalances: { some: { quantity: { gt: 0 } } } },
    ...(data.search ? { OR: [{ productName: { contains: data.search } }, { product: { name: { contains: data.search } } }, { batchNumber: { contains: data.search } }] } : {}),
  };
  const orderBy: Prisma.GoodsReceiptLineOrderByWithRelationInput[] =
    sort === "quantity" ? [{ baseQuantity: "desc" }, { id: "asc" }] : sort === "value" && showsValue ? [{ lineCost: "desc" }, { id: "asc" }] : [{ expiryDate: "asc" }, { id: "asc" }];
  const [total, lines] = await Promise.all([
    db.goodsReceiptLine.count({ where }),
    db.goodsReceiptLine.findMany({
      where,
      orderBy,
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
      select: {
        productId: true,
        productName: true,
        batchNumber: true,
        expiryDate: true,
        quantity: true,
        unitName: true,
        lineCost: true,
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

  /** Whole months from today to a day: the largest count of months that still lands on or before it. */
  const monthsUntil = (day: string) => {
    if (day <= today) return 0;
    let count = 0;
    while (count < 600 && addMonths(today, count + 1) <= day) count += 1;
    return count;
  };

  return {
    months,
    usualMonths,
    until,
    sort: sort === "value" && !showsValue ? "expiry" : sort,
    showsValue,
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
        soon: expiryDate <= soonUntil,
        monthsLeft: monthsUntil(expiryDate),
        quantity: line.quantity.toFixed(3),
        unitName: line.unitName,
        value: showsValue ? line.lineCost.toFixed(2) : null,
        stockNow: quantityToString(stockNow),
        baseUnitName: line.product.units[0]?.name ?? "",
      };
    }),
    ...paged(total, page),
  };
}
