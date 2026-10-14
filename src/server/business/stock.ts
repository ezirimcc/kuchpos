import "server-only";
import { z } from "zod";
import { Prisma } from "@/generated/prisma/client";
import { Decimal } from "@/lib/decimal";
import { addMonths, dateToDay, dayToDate, formatDay, shopDayEnd, shopDayStart, shopToday } from "@/lib/format";
import { quantityToString } from "@/lib/quantity";
import { lineTotal, moneyToString } from "@/lib/money";
import type { AppContext } from "@/server/auth/context";
import { parseInput } from "@/server/auth/users";
import { businessDb } from "@/server/db/scoped";
import { NotFoundError, ValidationError } from "@/server/errors";
import { optionalText } from "@/server/input";
import { PAGE_SIZE, type Paged, paged, pageNumber } from "@/server/paging";
import { EXPIRY_MONTH_CHOICES } from "@/lib/expiry";
import { authorize, can } from "@/server/permissions";
import { batchesAreBehind, batchesIn, settleAllStoreroomBatches, settleStoreroomBatches } from "@/server/stock-batches";
import { countUnreconciledSales, unreconciledSales } from "@/server/stock-owed";
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
  /**
   * What each place owes because a sale took more than it held (C72), and in all. A place
   * that owes holds nothing, and the screen shows what it owes as a minus figure.
   */
  owedByLocation: Record<string, string>;
  owed: string;
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
        stockOwed: { where: { quantity: { gt: 0 } }, select: { locationId: true, quantity: true } },
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
        owedByLocation: Object.fromEntries(product.stockOwed.map((owed) => [owed.locationId, owed.quantity.toFixed(3)])),
        owed: quantityToString(product.stockOwed.reduce((owing, owed) => owing.plus(owed.quantity.toFixed(3)), new Decimal(0))),
      };
    }),
    ...paged(total, page),
  };
}

// ---------------------------------------------------------------------------
// Expiring soon
// ---------------------------------------------------------------------------

export type ExpiringRow = {
  /** One row per batch the STOREROOM still holds (C76): what is left of it, not what was delivered. */
  batchId: string;
  productId: string;
  productName: string;
  batchNumber: string | null;
  expiryDate: string;
  /** The day the batch first came in. */
  receivedOn: string;
  /** True when the date has already passed. */
  expired: boolean;
  /** True when it expires within the business's own "expiring soon" period (or has expired): shown in red. */
  soon: boolean;
  /** Whole months from today until it expires; 0 once it has under a month left or has expired. */
  monthsLeft: number;
  /** What is left of this batch in the Storeroom, in base units. */
  quantity: string;
  baseUnitName: string;
  /** Units in use, for showing the quantity as "2 carton + 7 sachet". */
  units: { name: string; factor: string }[];
  /** That quantity at the product's average cost; null for those who do not see costs. */
  value: string | null;
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
): Promise<{ rows: ExpiringRow[]; months: number; usualMonths: number; until: string; sort: ExpirySort; showsValue: boolean; storeroomName: string } & Paged> {
  authorize(context, "report.stock.view");
  const data = parseInput(expiringSchema, input);
  const page = data.page;
  const db = businessDb(context);

  const [business, storeroom] = await Promise.all([
    db.business.findFirst({ select: { expiringSoonMonths: true } }),
    db.location.findFirst({ where: { kind: "STOREROOM" }, select: { id: true, name: true } }),
  ]);
  const usualMonths = business?.expiringSoonMonths ?? 3;
  const asked = Number.parseInt(data.months, 10);
  const months = (EXPIRY_MONTH_CHOICES as readonly number[]).includes(asked) ? asked : usualMonths;
  const sort = (EXPIRY_SORTS as readonly string[]).includes(data.sort) ? (data.sort as ExpirySort) : "expiry";
  const today = shopToday();
  const until = addMonths(today, months);
  const soonUntil = addMonths(today, usualMonths);
  // Costs are for those who may see deliveries with their costs (C36).
  const showsValue = can(context, "stock.receipts.view");
  const result = { months, usualMonths, until, sort: sort === "value" && !showsValue ? ("expiry" as const) : sort, showsValue, storeroomName: storeroom?.name ?? "Storeroom" };
  if (!storeroom) return { ...result, rows: [], ...paged(0, page) };

  // Batches are what the Storeroom holds (C76); stock from before they were recorded is split once first.
  await settleAllStoreroomBatches(context, storeroom.id);

  const batches = await db.stockBatchBalance.findMany({
    where: {
      locationId: storeroom.id,
      quantity: { gt: 0 },
      batch: { expiryDate: { not: null, lte: dayToDate(until)! } },
      product: { deactivatedAt: null },
      ...(data.search ? { OR: [{ product: { name: { contains: data.search } } }, { batch: { batchNumber: { contains: data.search } } }] } : {}),
    },
    select: {
      quantity: true,
      batch: { select: { id: true, batchNumber: true, expiryDate: true, receivedOn: true } },
      product: {
        select: {
          id: true,
          name: true,
          averageCost: true,
          units: { where: { retiredAt: null }, orderBy: { factor: "asc" }, select: { name: true, factor: true, isBase: true } },
        },
      },
    },
  });

  /** Whole months from today to a day: the largest count of months that still lands on or before it. */
  const monthsUntil = (day: string) => {
    if (day <= today) return 0;
    let count = 0;
    while (count < 600 && addMonths(today, count + 1) <= day) count += 1;
    return count;
  };

  // A Storeroom holds a few hundred batches at most: sorted and paged here.
  const all = batches.map((row) => {
    const expiryDate = dateToDay(row.batch.expiryDate!);
    const quantity = new Decimal(row.quantity.toFixed(3));
    const value = lineTotal(quantity, new Decimal(row.product.averageCost.toFixed(4)));
    return {
      row: {
        batchId: row.batch.id,
        productId: row.product.id,
        productName: row.product.name,
        batchNumber: row.batch.batchNumber,
        expiryDate,
        receivedOn: dateToDay(row.batch.receivedOn),
        expired: expiryDate < today,
        soon: expiryDate <= soonUntil,
        monthsLeft: monthsUntil(expiryDate),
        quantity: quantityToString(quantity),
        baseUnitName: row.product.units.find((unit) => unit.isBase)?.name ?? "",
        units: row.product.units.map((unit) => ({ name: unit.name, factor: unit.factor.toFixed(3) })),
        value: showsValue ? moneyToString(value) : null,
      } satisfies ExpiringRow,
      quantity,
      value,
    };
  });
  all.sort((a, b) => {
    const order =
      result.sort === "quantity" ? b.quantity.comparedTo(a.quantity) : result.sort === "value" ? b.value.comparedTo(a.value) : a.row.expiryDate.localeCompare(b.row.expiryDate);
    return order || a.row.expiryDate.localeCompare(b.row.expiryDate) || a.row.productName.localeCompare(b.row.productName) || a.row.batchId.localeCompare(b.row.batchId);
  });
  return {
    ...result,
    rows: all.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE).map((entry) => entry.row),
    ...paged(all.length, page),
  };
}

// ---------------------------------------------------------------------------
// Sold beyond stock (C72)
// ---------------------------------------------------------------------------

export type StockOwedList = { rows: Awaited<ReturnType<typeof unreconciledSales>>; salesCount: number };

/**
 * The products a place still owes because a sale made without internet (or brought in from
 * Excel) took more than the system held there, with the sales not yet covered. It empties
 * by itself as stock arrives in those places: by a transfer, a delivery or an adjustment.
 */
export async function listStockOwed(context: AppContext): Promise<StockOwedList> {
  authorize(context, "report.stock.view");
  const rows = await unreconciledSales(businessDb(context));
  return { rows, salesCount: countUnreconciledSales(rows) };
}

// ---------------------------------------------------------------------------
// A product's batches (C73, step 1)
// ---------------------------------------------------------------------------

export type ProductBatches = {
  /** False for a product without batch numbers or expiry dates: it has no batches. */
  tracked: boolean;
  baseUnitName: string;
  /** The Storeroom, where batches are kept (C76), and how much is on the Shelf — not counted by batch. */
  storeroom: { id: string; name: string } | null;
  onShelf: string;
  /** The Storeroom's batches that still hold something, the one that should go first on top. */
  batches: {
    id: string;
    batchNumber: string | null;
    expiryDate: string | null;
    /** True when the expiry date has passed; `soon` when it falls within the business's "expiring soon" period. */
    expired: boolean;
    soon: boolean;
    /** The day the first of it came in. */
    receivedOn: string;
    quantity: string;
  }[];
  /** Batches that were in the Storeroom and are now used up there, latest expiry first (C78). Kept for the record; offered nowhere. */
  finished: { id: string; batchNumber: string | null; expiryDate: string | null; receivedOn: string }[];
  /** Whether this person may open a batch's history (`report.stock.view`). */
  canOpenHistory: boolean;
};

/**
 * What is left of each batch of a product in the Storeroom (C76), the one that should go first
 * on top (earliest expiry, then first in). The Shelf holds a quantity only. Stock that was in
 * the Storeroom before batches were recorded is split into batches here, once.
 */
export async function getProductBatches(context: AppContext, input: unknown): Promise<ProductBatches> {
  authorize(context, "stock.view");
  const { productId } = parseInput(z.object({ productId: z.string().uuid("That product could not be found.") }), input);
  const db = businessDb(context);
  const product = await db.product.findFirst({
    where: { id: productId },
    select: { id: true, tracksBatch: true, tracksExpiry: true, units: { where: { isBase: true }, select: { name: true } }, stockBalances: { select: { quantity: true, location: { select: { kind: true } } } } },
  });
  if (!product) throw new NotFoundError("That product could not be found.");
  const [storeroom, business] = await Promise.all([
    db.location.findFirst({ where: { kind: "STOREROOM" }, select: { id: true, name: true } }),
    db.business.findFirst({ select: { expiringSoonMonths: true } }),
  ]);
  const baseUnitName = product.units[0]?.name ?? "";
  const onShelf = quantityToString(product.stockBalances.filter((balance) => balance.location.kind === "SHELF").reduce((sum, balance) => sum.plus(balance.quantity.toFixed(3)), new Decimal(0)));
  const canOpenHistory = can(context, "report.stock.view");
  if (!product.tracksBatch && !product.tracksExpiry) return { tracked: false, baseUnitName, storeroom, onShelf, batches: [], finished: [], canOpenHistory };

  if (await batchesAreBehind(db, product.id)) {
    await db.$transaction(
      async (tx) => {
        await tx.product.update({ where: { id: product.id }, data: { updatedAt: new Date() }, select: { id: true } });
        await settleStoreroomBatches(tx, context, product.id);
      },
      { isolationLevel: "ReadCommitted" },
    );
  }

  const today = shopToday();
  const soonUntil = addMonths(today, business?.expiringSoonMonths ?? 3);
  const rows = storeroom ? await batchesIn(db, product.id, storeroom.id) : [];
  // Finished: was in the Storeroom (a movement there names it) and nothing of it is left there.
  const finished = storeroom
    ? await db.stockBatch.findMany({
        where: { productId: product.id, movements: { some: { locationId: storeroom.id } }, balances: { none: { locationId: storeroom.id, quantity: { gt: 0 } } } },
        orderBy: [{ expiryDate: "desc" }, { receivedOn: "desc" }],
        take: 200,
        select: { id: true, batchNumber: true, expiryDate: true, receivedOn: true },
      })
    : [];
  return {
    tracked: true,
    baseUnitName,
    storeroom,
    onShelf,
    canOpenHistory,
    finished: finished.map((batch) => ({ id: batch.id, batchNumber: batch.batchNumber, expiryDate: batch.expiryDate ? dateToDay(batch.expiryDate) : null, receivedOn: dateToDay(batch.receivedOn) })),
    batches: rows.map((row) => ({
      id: row.id,
      batchNumber: row.batchNumber,
      expiryDate: row.expiryDate,
      expired: row.expiryDate !== null && row.expiryDate < today,
      soon: row.expiryDate !== null && row.expiryDate <= soonUntil,
      receivedOn: row.receivedOn,
      quantity: row.quantity,
    })),
  };
}

// ---------------------------------------------------------------------------
// A product's stock history (C74)
// ---------------------------------------------------------------------------

export type StockHistoryRow = {
  id: string;
  at: Date;
  type: string;
  locationId: string;
  locationName: string;
  /** In the product's smallest unit: above zero came in, below zero went out. */
  quantity: string;
  /** As it was entered: "2 carton", "−3 sachet". */
  entered: string;
  /** What that place held straight after this movement, and what the business held in all. */
  leftThere: string;
  leftInAll: string;
  userName: string;
  /** The Storeroom batch it went into or came out of (C76): "B12 (expires 1 Mar 2027)"; null when none was recorded. */
  batch: string | null;
  /** That batch, for a link to its own history (C78). */
  batchId: string | null;
  documentNumber: string;
  /** Where the document can be opened; null when it has no page of its own. */
  documentHref: string | null;
};

export type StockHistory = {
  product: { id: string; name: string; baseUnitName: string };
  period: { from: string; to: string };
  locations: { id: string; name: string }[];
  /** What each place held when the period began and when it ended, and in all. */
  opening: { byLocation: Record<string, string>; total: string };
  closing: { byLocation: Record<string, string>; total: string };
  /** Totals of the period. */
  cameIn: string;
  wentOut: string;
  /** Oldest first, each with what was left afterwards. At most `STOCK_HISTORY_ROWS`; `more` says how many are not shown. */
  rows: StockHistoryRow[];
  more: number;
};

const STOCK_HISTORY_ROWS = 1000;
const historySchema = z.object({
  productId: z.string().uuid("That product could not be found."),
  from: z.string().trim().optional().default(""),
  to: z.string().trim().optional().default(""),
});

/** Where the document behind a movement can be opened. */
// ---------------------------------------------------------------------------
// One batch's history (C78)
// ---------------------------------------------------------------------------

export type BatchHistory = {
  batch: {
    id: string;
    batchNumber: string | null;
    expiryDate: string | null;
    expired: boolean;
    receivedOn: string;
  };
  product: { id: string; name: string; baseUnitName: string };
  storeroomName: string;
  /** What is left of it in the Storeroom now; "0.000" once it is finished. */
  left: string;
  /** When the last of it left the Storeroom; null while some is left. */
  finishedAt: Date | null;
  /** Stock that was already in the Storeroom when batches began to be recorded, given to this batch then (no movement of its own). */
  heldBeforeRecording: string;
  cameIn: string;
  wentOut: string;
  /** Oldest first, each with what was left of the batch afterwards. At most `STOCK_HISTORY_ROWS`; `more` says how many are not shown. */
  rows: (Omit<StockHistoryRow, "locationId" | "locationName" | "leftThere" | "leftInAll" | "batch" | "batchId"> & { leftInBatch: string })[];
  more: number;
};

/**
 * Everything that has happened to one Storeroom batch (C78): every movement that names it, with
 * what was left of the batch after each, and whether it is finished. A finished batch is no
 * longer offered anywhere, but this history stays.
 */
export async function getBatchHistory(context: AppContext, input: unknown): Promise<BatchHistory> {
  authorize(context, "report.stock.view");
  const { batchId } = parseInput(z.object({ batchId: z.string().uuid("That batch could not be found.") }), input);
  const db = businessDb(context);
  const batch = await db.stockBatch.findFirst({
    where: { id: batchId },
    select: { id: true, batchNumber: true, expiryDate: true, receivedOn: true, product: { select: { id: true, name: true, units: { where: { isBase: true }, select: { name: true } } } } },
  });
  if (!batch) throw new NotFoundError("That batch could not be found.");
  const storeroom = await db.location.findFirst({ where: { kind: "STOREROOM" }, select: { id: true, name: true } });
  if (!storeroom) throw new NotFoundError("That batch could not be found.");
  // Old stock is split into batches once, the first time it is looked at.
  if (await batchesAreBehind(db, batch.product.id)) await settleAllStoreroomBatches(context, storeroom.id);

  const where = { batchId: batch.id, locationId: storeroom.id };
  const [balance, all, total, movements, signed] = await Promise.all([
    db.stockBatchBalance.findFirst({ where, select: { quantity: true } }),
    db.stockMovement.aggregate({ where, _sum: { quantityDelta: true } }),
    db.stockMovement.count({ where }),
    db.stockMovement.findMany({
      where,
      orderBy: [{ createdAt: "asc" }, { quantityDelta: "asc" }, { id: "asc" }],
      take: STOCK_HISTORY_ROWS,
      select: { id: true, createdAt: true, type: true, quantityDelta: true, unitName: true, unitQuantity: true, documentType: true, documentId: true, documentNumber: true, userName: true },
    }),
    Promise.all([
      db.stockMovement.aggregate({ where: { ...where, quantityDelta: { gt: 0 } }, _sum: { quantityDelta: true } }),
      db.stockMovement.aggregate({ where: { ...where, quantityDelta: { lt: 0 } }, _sum: { quantityDelta: true } }),
    ]),
  ]);
  const amount = (value: { toFixed(places: number): string } | null | undefined) => new Decimal(value?.toFixed(3) ?? "0");
  const left = amount(balance?.quantity);
  // What the movements do not account for was given to the batch when batches began to be recorded.
  const before = left.minus(amount(all._sum.quantityDelta));
  let running = before;
  const rows = movements.map((movement) => {
    running = running.plus(amount(movement.quantityDelta));
    return {
      id: movement.id,
      at: movement.createdAt,
      type: movement.type,
      quantity: quantityToString(amount(movement.quantityDelta)),
      entered: `${movement.unitQuantity.toFixed(3)} ${movement.unitName}`,
      leftInBatch: quantityToString(running),
      userName: movement.userName,
      documentNumber: movement.documentNumber,
      documentHref: documentHref(movement.documentType, movement.documentId),
    };
  });
  const expiryDate = batch.expiryDate ? dateToDay(batch.expiryDate) : null;
  return {
    batch: { id: batch.id, batchNumber: batch.batchNumber, expiryDate, expired: expiryDate !== null && expiryDate < shopToday(), receivedOn: dateToDay(batch.receivedOn) },
    product: { id: batch.product.id, name: batch.product.name, baseUnitName: batch.product.units[0]?.name ?? "" },
    storeroomName: storeroom.name,
    left: quantityToString(left),
    finishedAt: left.greaterThan(0) ? null : (movements.at(-1)?.createdAt ?? null),
    heldBeforeRecording: quantityToString(before),
    cameIn: quantityToString(amount(signed[0]._sum.quantityDelta)),
    wentOut: quantityToString(amount(signed[1]._sum.quantityDelta).negated()),
    rows,
    more: Math.max(0, total - rows.length),
  };
}

function documentHref(documentType: string, documentId: string): string | null {
  if (documentType === "sale") return `/sales/${documentId}`;
  if (documentType === "goods_receipt") return `/stock/receipts/${documentId}`;
  if (documentType === "stock_transfer") return `/stock/transfers/${documentId}`;
  if (documentType === "stock_adjustment") return `/stock/adjustments/${documentId}`;
  if (documentType === "sale_return") return `/returns/${documentId}`;
  if (documentType === "stock_owed") return "/stock/owed";
  return null;
}

/**
 * Every movement of one product's stock in a period, oldest first, with what was left in
 * that place and in all after each (C74) — for tracking and audits. The period is whole shop
 * days; this month so far when none is given, at most five years.
 *
 * "What was left" is exact, not an estimate: it starts from what is held now, takes off
 * everything that has moved since the period began, and then follows the movements one by one.
 */
export async function getProductStockHistory(context: AppContext, input: unknown): Promise<StockHistory> {
  authorize(context, "report.stock.view");
  const data = parseInput(historySchema, input);
  const db = businessDb(context);
  const product = await db.product.findFirst({ where: { id: data.productId }, select: { id: true, name: true, units: { where: { isBase: true }, select: { name: true } } } });
  if (!product) throw new NotFoundError("That product could not be found.");

  const today = shopToday();
  const to = dayToDate(data.to) ? data.to : today;
  const from = dayToDate(data.from) ? data.from : `${to.slice(0, 8)}01`;
  if (from > to) throw new ValidationError("The first day of the period is after the last day.", { from: "Choose a first day on or before the last day." });
  if (dayToDate(to)!.getTime() - dayToDate(from)!.getTime() > 5 * 366 * 24 * 60 * 60 * 1000) throw new ValidationError("A period can cover at most five years. Choose a shorter one.", { from: "At most five years." });
  const start = shopDayStart(from)!;
  const end = shopDayEnd(to)!;

  const [locations, balances, since, total, movements] = await Promise.all([
    db.location.findMany({ orderBy: { kind: "asc" }, select: { id: true, name: true } }),
    db.stockBalance.findMany({ where: { productId: product.id }, select: { locationId: true, quantity: true } }),
    // Everything that has moved from the start of the period until now, per place: taken off what is held now, it gives what was held when the period began.
    db.stockMovement.groupBy({ by: ["locationId"], where: { productId: product.id, createdAt: { gte: start } }, _sum: { quantityDelta: true } }),
    db.stockMovement.count({ where: { productId: product.id, createdAt: { gte: start, lt: end } } }),
    db.stockMovement.findMany({
      where: { productId: product.id, createdAt: { gte: start, lt: end } },
      // The two halves of a transfer are written at the same instant: the half that leaves is
      // listed first, so "left in all" never shows goods counted twice.
      orderBy: [{ createdAt: "asc" }, { quantityDelta: "asc" }, { id: "asc" }],
      take: STOCK_HISTORY_ROWS,
      select: { id: true, createdAt: true, type: true, locationId: true, quantityDelta: true, unitName: true, unitQuantity: true, documentType: true, documentId: true, documentNumber: true, userName: true, batchId: true, batch: { select: { batchNumber: true, expiryDate: true } } },
    }),
  ]);
  const inPeriod = await db.stockMovement.groupBy({ by: ["locationId"], where: { productId: product.id, createdAt: { gte: start, lt: end } }, _sum: { quantityDelta: true } });
  const signed = await Promise.all([
    db.stockMovement.aggregate({ where: { productId: product.id, createdAt: { gte: start, lt: end }, quantityDelta: { gt: 0 } }, _sum: { quantityDelta: true } }),
    db.stockMovement.aggregate({ where: { productId: product.id, createdAt: { gte: start, lt: end }, quantityDelta: { lt: 0 } }, _sum: { quantityDelta: true } }),
  ]);

  const amount = (value: { toFixed(places: number): string } | null | undefined) => new Decimal(value?.toFixed(3) ?? "0");
  const held = new Map(locations.map((location) => [location.id, new Decimal(0)]));
  for (const balance of balances) held.set(balance.locationId, amount(balance.quantity));
  for (const group of since) held.set(group.locationId, (held.get(group.locationId) ?? new Decimal(0)).minus(amount(group._sum.quantityDelta)));
  const asText = (map: Map<string, Decimal>) => ({
    byLocation: Object.fromEntries([...map.entries()].map(([id, quantity]) => [id, quantityToString(quantity)])),
    total: quantityToString([...map.values()].reduce((sum, quantity) => sum.plus(quantity), new Decimal(0))),
  });
  const opening = asText(held);
  const closingMap = new Map(held);
  for (const group of inPeriod) closingMap.set(group.locationId, (closingMap.get(group.locationId) ?? new Decimal(0)).plus(amount(group._sum.quantityDelta)));

  const nameOf = new Map(locations.map((location) => [location.id, location.name]));
  const running = new Map(held);
  let all = [...held.values()].reduce((sum, quantity) => sum.plus(quantity), new Decimal(0));
  const rows = movements.map((movement) => {
    const delta = amount(movement.quantityDelta);
    const there = (running.get(movement.locationId) ?? new Decimal(0)).plus(delta);
    running.set(movement.locationId, there);
    all = all.plus(delta);
    return {
      id: movement.id,
      at: movement.createdAt,
      type: movement.type,
      locationId: movement.locationId,
      locationName: nameOf.get(movement.locationId) ?? "",
      quantity: quantityToString(delta),
      entered: `${movement.unitQuantity.toFixed(3)} ${movement.unitName}`,
      leftThere: quantityToString(there),
      leftInAll: quantityToString(all),
      userName: movement.userName,
      batch: movement.batch
        ? [movement.batch.batchNumber ?? "No batch number", movement.batch.expiryDate ? `(expires ${formatDay(dateToDay(movement.batch.expiryDate))})` : ""].filter(Boolean).join(" ")
        : null,
      batchId: movement.batchId,
      documentNumber: movement.documentNumber,
      documentHref: documentHref(movement.documentType, movement.documentId),
    };
  });

  return {
    product: { id: product.id, name: product.name, baseUnitName: product.units[0]?.name ?? "" },
    period: { from, to },
    locations,
    opening,
    closing: asText(closingMap),
    cameIn: quantityToString(amount(signed[0]._sum.quantityDelta)),
    wentOut: quantityToString(amount(signed[1]._sum.quantityDelta).negated()),
    rows,
    more: Math.max(0, total - rows.length),
  };
}
