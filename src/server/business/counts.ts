import "server-only";
import { z } from "zod";
import { Prisma } from "@/generated/prisma/client";
import type { AdjustmentStatus } from "@/lib/adjustment-reasons";
import { Decimal } from "@/lib/decimal";
import { countNumber, plainNumber, shopDayEnd, shopDayStart } from "@/lib/format";
import { parseQuantity, quantityToString, toBaseQuantity } from "@/lib/quantity";
import { activityRow } from "@/server/activity";
import type { AppContext } from "@/server/auth/context";
import { parseInput } from "@/server/auth/users";
import { businessDb, businessIdOf } from "@/server/db/scoped";
import { NotFoundError, ValidationError } from "@/server/errors";
import { optionalText } from "@/server/input";
import { PAGE_SIZE, type Paged, paged, pageNumber } from "@/server/paging";
import { takeDocumentNumber } from "@/server/document-number";
import { authorize, can } from "@/server/permissions";

/**
 * Stock counts for the business in use: what staff physically counted in one location,
 * set against what the system held at the moment the count was saved.
 *
 * A count is "blind" (SPEC C41): the sheet never shows the expected quantity; it is recorded
 * and shown only once the count is saved. A count changes no stock. Its differences can be
 * turned into one adjustment (see adjustments.ts). A saved count is never changed.
 */

const MAX_LINES = 500;
const MAX_UNIT_QUANTITY = new Decimal("9999999.999");
const MAX_BASE_QUANTITY = new Decimal("999999999.999");

// ---------------------------------------------------------------------------
// The count sheet
// ---------------------------------------------------------------------------

export type CountSheetProduct = {
  id: string;
  name: string;
  code: string | null;
  categoryId: string | null;
  category: string | null;
  allowsFraction: boolean;
  baseUnitName: string;
  /** Units in use, largest first, so a shelf can be counted as "2 carton, 7 single". */
  units: { id: string; name: string; factor: string; isBase: boolean }[];
};

export type CountSheet = {
  locations: { id: string; name: string }[];
  categories: { id: string; name: string }[];
  /** The products to count: all in use, or those of the chosen category. Deliberately WITHOUT stock figures. */
  products: CountSheetProduct[];
};

const sheetSchema = z.object({ category: z.string().trim().max(40).optional().default("") });

export async function getCountSheet(context: AppContext, input: unknown = {}): Promise<CountSheet> {
  authorize(context, "stock.count");
  const { category } = parseInput(sheetSchema, input);
  const db = businessDb(context);
  const [locations, categories, products] = await Promise.all([
    db.location.findMany({ orderBy: { kind: "asc" }, select: { id: true, name: true } }),
    db.category.findMany({ orderBy: { name: "asc" }, select: { id: true, name: true } }),
    db.product.findMany({
      where: {
        deactivatedAt: null,
        ...(category === "none" ? { categoryId: null } : category ? { categoryId: category } : {}),
      },
      orderBy: [{ name: "asc" }, { id: "asc" }],
      select: {
        id: true,
        name: true,
        code: true,
        allowsFraction: true,
        categoryId: true,
        category: { select: { name: true } },
        units: {
          where: { retiredAt: null },
          orderBy: { factor: "desc" },
          select: { id: true, name: true, factor: true, isBase: true },
        },
      },
    }),
  ]);
  return {
    locations,
    categories,
    products: products.map((product) => ({
      id: product.id,
      name: product.name,
      code: product.code,
      categoryId: product.categoryId,
      category: product.category?.name ?? null,
      allowsFraction: product.allowsFraction,
      baseUnitName: product.units.find((unit) => unit.isBase)?.name ?? "",
      units: product.units.map((unit) => ({ id: unit.id, name: unit.name, factor: unit.factor.toFixed(3), isBase: unit.isBase })),
    })),
  };
}

// ---------------------------------------------------------------------------
// Saving a count
// ---------------------------------------------------------------------------

const submitSchema = z.object({
  requestId: z.string().uuid("This form has expired. Reload the page and enter the count again."),
  locationId: z.string().uuid("Choose the location that was counted."),
  /** The category the sheet was narrowed to ("" for all products, "none" for products without one). */
  category: z.string().trim().max(40).optional().default(""),
  note: optionalText(300, "The note is too long (300 characters at most).").optional().default(""),
  /** Only the products that were actually counted. A product left out is "not counted", never "zero". */
  lines: z
    .array(
      z.object({
        productId: z.string().trim(),
        entries: z.array(z.object({ unitId: z.string().trim(), quantity: z.string().trim() })).max(20),
      }),
    )
    .min(1, "Enter what you counted for at least one product.")
    .max(MAX_LINES, `A count can have at most ${MAX_LINES} products. Count one category at a time.`),
});

export type CountResult = { id: string; number: number; alreadySaved: boolean };

/**
 * Saves a stock count: for each counted product, what was counted (in base units), what the
 * system held in that location at this moment, and the difference. Changes no stock.
 * `requestId` makes a repeated submission harmless.
 */
export async function submitCount(context: AppContext, input: unknown): Promise<CountResult> {
  authorize(context, "stock.count");
  const businessId = businessIdOf(context);
  const data = parseInput(submitSchema, input);
  const db = businessDb(context);

  const alreadySaved = async (): Promise<CountResult | null> => {
    const saved = await db.stockCount.findFirst({ where: { requestId: data.requestId }, select: { id: true, number: true } });
    return saved ? { ...saved, alreadySaved: true } : null;
  };
  const repeat = await alreadySaved();
  if (repeat) return repeat;

  const fieldErrors: Record<string, string> = {};
  const location = await db.location.findFirst({ where: { id: data.locationId }, select: { id: true, name: true } });
  if (!location) fieldErrors.locationId = "Choose the location that was counted.";

  let categoryName: string | null = null;
  if (data.category === "none") categoryName = "No category";
  else if (data.category) {
    const category = await db.category.findFirst({ where: { id: data.category }, select: { name: true } });
    if (!category) fieldErrors.category = "Choose a category from the list.";
    categoryName = category?.name ?? null;
  }

  const productIds = [...new Set(data.lines.map((line) => line.productId).filter(Boolean))];
  const products = await db.product.findMany({
    where: { id: { in: productIds } },
    select: {
      id: true,
      name: true,
      allowsFraction: true,
      deactivatedAt: true,
      units: { orderBy: { factor: "desc" }, select: { id: true, name: true, factor: true, isBase: true, retiredAt: true } },
    },
  });
  const productById = new Map(products.map((product) => [product.id, product]));

  type Counted = { productId: string; productName: string; baseUnitId: string; baseUnitName: string; enteredAs: string; counted: Decimal };
  const counted: Counted[] = [];
  const seen = new Set<string>();
  for (const line of data.lines) {
    // Problems are reported by product, because the sheet is a list of products.
    const at = `lines.${line.productId}`;
    const product = productById.get(line.productId);
    if (!product || product.deactivatedAt) {
      fieldErrors[at] = "This product is no longer in use. Reload the page.";
      continue;
    }
    if (seen.has(product.id)) {
      fieldErrors[at] = `"${product.name}" appears twice on this count.`;
      continue;
    }
    seen.add(product.id);
    const base = product.units.find((unit) => unit.isBase);
    const entries = line.entries.filter((entry) => entry.quantity !== "");
    if (!base || entries.length === 0) {
      fieldErrors[at] = "Enter how many you counted, or leave every box of this product empty.";
      continue;
    }

    let total = new Decimal(0);
    const parts: string[] = [];
    let bad = false;
    // Largest unit first, whatever order the browser sent them in.
    for (const unit of product.units) {
      const entry = entries.find((candidate) => candidate.unitId === unit.id);
      if (!entry) continue;
      if (unit.retiredAt) {
        fieldErrors[at] = `"${unit.name}" is no longer a unit of "${product.name}". Reload the page.`;
        bad = true;
        break;
      }
      try {
        const quantity = parseQuantity(entry.quantity);
        if (quantity.isNegative() || quantity.greaterThan(MAX_UNIT_QUANTITY)) throw new Error("out of range");
        if (!product.allowsFraction && !quantity.isInteger()) {
          fieldErrors[at] = `"${product.name}" comes in whole units only. Enter whole numbers.`;
          bad = true;
          break;
        }
        total = total.plus(toBaseQuantity(quantity, new Decimal(unit.factor.toFixed(3))));
        if (quantity.greaterThan(0)) parts.push(`${plainNumber(quantityToString(quantity))} ${unit.name}`);
      } catch {
        fieldErrors[at] = "Enter each amount as a number, zero or more (up to 3 decimal places).";
        bad = true;
        break;
      }
    }
    if (bad) continue;
    if (entries.some((entry) => !product.units.some((unit) => unit.id === entry.unitId))) {
      fieldErrors[at] = "One of these units does not belong to this product. Reload the page.";
      continue;
    }
    if (total.greaterThan(MAX_BASE_QUANTITY)) {
      fieldErrors[at] = "That amount is too large. Check what was typed.";
      continue;
    }
    counted.push({
      productId: product.id,
      productName: product.name,
      baseUnitId: base.id,
      baseUnitName: base.name,
      enteredAs: parts.length > 0 ? parts.join(" + ") : `0 ${base.name}`,
      counted: total,
    });
  }

  if (Object.keys(fieldErrors).length > 0 || !location) {
    throw new ValidationError("Nothing was saved. Please correct the highlighted products.", fieldErrors);
  }

  try {
    return await db.$transaction(
      async (tx) => {
        const number = await takeDocumentNumber(tx, businessId, "STOCK_COUNT");

        const count = await tx.stockCount.create({
          data: {
            businessId,
            requestId: data.requestId,
            number,
            locationId: location.id,
            locationName: location.name,
            categoryName,
            note: data.note || null,
            createdByUserId: context.actor.userId,
            createdByName: context.actor.name,
          },
        });

        // What the system holds right now — the figure the person counting never saw.
        const balances = await tx.stockBalance.findMany({
          where: { locationId: location.id, productId: { in: counted.map((line) => line.productId) } },
          select: { productId: true, quantity: true },
        });
        const expectedOf = new Map(balances.map((balance) => [balance.productId, new Decimal(balance.quantity.toFixed(3))]));

        let differences = 0;
        await tx.stockCountLine.createMany({
          data: counted.map((line, position) => {
            const expected = expectedOf.get(line.productId) ?? new Decimal(0);
            const difference = line.counted.minus(expected);
            if (!difference.isZero()) differences++;
            return {
              businessId,
              countId: count.id,
              lineNumber: position + 1,
              productId: line.productId,
              productName: line.productName,
              baseUnitId: line.baseUnitId,
              baseUnitName: line.baseUnitName,
              enteredAs: line.enteredAs,
              countedQuantity: quantityToString(line.counted),
              expectedQuantity: quantityToString(expected),
              difference: quantityToString(difference),
            };
          }),
        });

        await tx.activityLog.create({
          data: activityRow(context, {
            action: "stock.counted",
            summary:
              `${context.actor.name} counted ${counted.length} product${counted.length === 1 ? "" : "s"} in ${location.name} ` +
              `(count ${countNumber(number)}): ` +
              (differences === 0 ? "everything matched." : `${differences} did not match the system.`),
            targetType: "stock_count",
            targetId: count.id,
            details: { number, location: location.name, products: counted.length, differences },
          }),
        });

        return { id: count.id, number, alreadySaved: false };
      },
      { isolationLevel: "ReadCommitted", timeout: 20_000 },
    );
  } catch (error) {
    // The same submission arrived twice at the same moment: return the one that was saved.
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      const saved = await alreadySaved();
      if (saved) return saved;
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Counts: list and detail
// ---------------------------------------------------------------------------

export type CountSummary = {
  id: string;
  number: number;
  locationName: string;
  categoryName: string | null;
  productCount: number;
  /** How many of the counted products did not match the system. */
  differences: number;
  adjustment: { id: string; number: number; status: AdjustmentStatus } | null;
  createdByName: string;
  createdAt: Date;
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

const adjustmentSelect = { select: { id: true, number: true, decision: { select: { outcome: true } } } } as const;

function adjustmentOf(
  adjustment: { id: string; number: number; decision: { outcome: "APPLIED" | "REJECTED" } | null } | null,
): CountSummary["adjustment"] {
  return adjustment ? { id: adjustment.id, number: adjustment.number, status: adjustment.decision?.outcome ?? "PENDING" } : null;
}

/** One page of stock counts, newest first. */
export async function listCounts(
  context: AppContext,
  input: unknown = {},
): Promise<{ counts: CountSummary[]; canCount: boolean } & Paged> {
  authorize(context, "report.stock.view");
  const { search, from, to, page } = parseInput(listSchema, input);

  const createdAt: Prisma.DateTimeFilter = {};
  if (from) createdAt.gte = shopDayStart(from)!;
  if (to) createdAt.lte = shopDayEnd(to)!;
  const numberSearch = /^(?:sc-?)?0*(\d{1,9})$/i.exec(search)?.[1];

  const where: Prisma.StockCountWhereInput = {
    ...(from || to ? { createdAt } : {}),
    ...(search
      ? {
          OR: [
            { lines: { some: { productName: { contains: search } } } },
            { createdByName: { contains: search } },
            ...(numberSearch ? [{ number: Number.parseInt(numberSearch, 10) }] : []),
          ],
        }
      : {}),
  };
  const db = businessDb(context);
  const [total, rows] = await Promise.all([
    db.stockCount.count({ where }),
    db.stockCount.findMany({
      where,
      orderBy: [{ number: "desc" }],
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
      select: {
        id: true,
        number: true,
        locationName: true,
        categoryName: true,
        createdByName: true,
        createdAt: true,
        adjustment: adjustmentSelect,
        _count: { select: { lines: true } },
      },
    }),
  ]);
  const unmatched = await db.stockCountLine.groupBy({
    by: ["countId"],
    where: { countId: { in: rows.map((row) => row.id) }, NOT: { difference: 0 } },
    _count: { _all: true },
  });
  const differencesOf = new Map(unmatched.map((group) => [group.countId, group._count._all]));

  return {
    canCount: can(context, "stock.count"),
    counts: rows.map((row) => ({
      id: row.id,
      number: row.number,
      locationName: row.locationName,
      categoryName: row.categoryName,
      productCount: row._count.lines,
      differences: differencesOf.get(row.id) ?? 0,
      adjustment: adjustmentOf(row.adjustment),
      createdByName: row.createdByName,
      createdAt: row.createdAt,
    })),
    ...paged(total, page),
  };
}

export type CountDetail = CountSummary & {
  note: string | null;
  /** True when this person may record the adjustment for this count's differences now. */
  canAdjust: boolean;
  /** True when that adjustment would change stock at once; false when it would wait for approval. */
  appliesAtOnce: boolean;
  lines: {
    lineNumber: number;
    productId: string;
    productName: string;
    baseUnitName: string;
    enteredAs: string;
    counted: string;
    expected: string;
    difference: string;
  }[];
};

export async function getCount(context: AppContext, input: unknown): Promise<CountDetail> {
  authorize(context, "report.stock.view");
  const { countId } = parseInput(z.object({ countId: z.string().uuid("That count could not be found.") }), input);

  const row = await businessDb(context).stockCount.findFirst({
    where: { id: countId },
    include: { lines: { orderBy: { lineNumber: "asc" } }, adjustment: adjustmentSelect },
  });
  if (!row) throw new NotFoundError("That count could not be found.");
  const differences = row.lines.filter((line) => !line.difference.isZero()).length;
  return {
    id: row.id,
    number: row.number,
    locationName: row.locationName,
    categoryName: row.categoryName,
    productCount: row.lines.length,
    differences,
    adjustment: adjustmentOf(row.adjustment),
    note: row.note,
    createdByName: row.createdByName,
    createdAt: row.createdAt,
    canAdjust: differences > 0 && !row.adjustment && can(context, "stock.adjust.request"),
    appliesAtOnce: can(context, "stock.adjust.approve"),
    lines: row.lines.map((line) => ({
      lineNumber: line.lineNumber,
      productId: line.productId,
      productName: line.productName,
      baseUnitName: line.baseUnitName,
      enteredAs: line.enteredAs,
      counted: line.countedQuantity.toFixed(3),
      expected: line.expectedQuantity.toFixed(3),
      difference: line.difference.toFixed(3),
    })),
  };
}
