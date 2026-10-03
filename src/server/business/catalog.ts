import "server-only";
import { z } from "zod";
import { Prisma } from "@/generated/prisma/client";
import { Decimal } from "@/lib/decimal";
import { activityRow } from "@/server/activity";
import type { AppContext } from "@/server/auth/context";
import { parseInput } from "@/server/auth/users";
import { businessDb, businessIdOf } from "@/server/db/scoped";
import { NotFoundError, ValidationError } from "@/server/errors";
import { factorText, moneyText, optionalText, yesNo } from "@/server/input";
import { PAGE_SIZE, type Paged, paged, pageNumber } from "@/server/paging";
import { authorize } from "@/server/permissions";
import { formatNaira } from "@/lib/money";

/**
 * Products, their units and prices, for the business in use.
 *
 * Money and conversions cross this boundary as exact decimal text ("1250.50", "0.250").
 * A unit's name and conversion never change once created; to change them the unit is
 * retired and a new one added, so past records keep their meaning.
 */

const PRODUCT_NOT_FOUND = "That product could not be found.";
const UNIT_NOT_FOUND = "That unit could not be found.";
const FIX_FIELDS = "Please correct the highlighted fields.";
const CATEGORY_NOT_FOUND = "That category could not be found.";

export type UnitView = {
  id: string;
  name: string;
  /** Base units in one of this unit, as text with 3 decimal places. */
  factor: string;
  isBase: boolean;
  forSale: boolean;
  forPurchase: boolean;
  /** Selling price as text with 2 decimal places, or null when not for sale. */
  price: string | null;
  retired: boolean;
};

export type ProductView = {
  id: string;
  name: string;
  code: string | null;
  barcode: string | null;
  allowsFraction: boolean;
  taxable: boolean;
  tracksBatch: boolean;
  tracksExpiry: boolean;
  active: boolean;
  category: { id: string; name: string } | null;
  baseUnitName: string;
  units: UnitView[];
};

export type CategoryView = { id: string; name: string; productCount: number };

export type PriceChangeView = {
  id: string;
  createdAt: Date;
  unitName: string;
  oldPrice: string | null;
  newPrice: string | null;
  changedByName: string;
};

type UnitRow = {
  id: string;
  name: string;
  factor: Prisma.Decimal;
  isBase: boolean;
  forSale: boolean;
  forPurchase: boolean;
  price: Prisma.Decimal | null;
  retiredAt: Date | null;
};

function unitView(row: UnitRow): UnitView {
  return {
    id: row.id,
    name: row.name,
    factor: row.factor.toFixed(3),
    isBase: row.isBase,
    forSale: row.forSale,
    forPurchase: row.forPurchase,
    price: row.price ? row.price.toFixed(2) : null,
    retired: row.retiredAt !== null,
  };
}

type ProductRow = {
  id: string;
  name: string;
  code: string | null;
  barcode: string | null;
  allowsFraction: boolean;
  taxable: boolean;
  tracksBatch: boolean;
  tracksExpiry: boolean;
  deactivatedAt: Date | null;
  category: { id: string; name: string } | null;
  units: UnitRow[];
};

function productView(row: ProductRow): ProductView {
  // Base unit first, then smallest to largest.
  const units = [...row.units].sort((a, b) =>
    a.isBase === b.isBase ? a.factor.comparedTo(b.factor) : a.isBase ? -1 : 1,
  );
  return {
    id: row.id,
    name: row.name,
    code: row.code,
    barcode: row.barcode,
    allowsFraction: row.allowsFraction,
    taxable: row.taxable,
    tracksBatch: row.tracksBatch,
    tracksExpiry: row.tracksExpiry,
    active: row.deactivatedAt === null,
    category: row.category,
    baseUnitName: units.find((unit) => unit.isBase)?.name ?? "",
    units: units.map(unitView),
  };
}

const UNIT_SELECT = {
  id: true,
  name: true,
  factor: true,
  isBase: true,
  forSale: true,
  forPurchase: true,
  price: true,
  retiredAt: true,
} as const;

const PRODUCT_SELECT = {
  id: true,
  name: true,
  code: true,
  barcode: true,
  allowsFraction: true,
  taxable: true,
  tracksBatch: true,
  tracksExpiry: true,
  deactivatedAt: true,
  category: { select: { id: true, name: true } },
} as const;

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

const listSchema = z.object({
  search: z.string().trim().max(120).optional().default(""),
  /** A category id, or "none" for products without a category. Empty means every category. */
  category: z.string().trim().max(40).optional().default(""),
  includeInactive: z.boolean().optional().default(false),
  page: pageNumber,
});

/**
 * One page of products with their in-use units and prices, in name order.
 * Everyone in the business may look prices up.
 */
export async function listProducts(
  context: AppContext,
  input: unknown = {},
): Promise<{ products: ProductView[] } & Paged> {
  authorize(context, "price.view");
  const { search, category, includeInactive, page } = parseInput(listSchema, input);

  const where: Prisma.ProductWhereInput = {
    ...(includeInactive ? {} : { deactivatedAt: null }),
    ...(category === "none" ? { categoryId: null } : category ? { categoryId: category } : {}),
    ...(search
      ? { OR: [{ name: { contains: search } }, { code: { contains: search } }, { barcode: search }] }
      : {}),
  };
  const db = businessDb(context);
  const [total, rows] = await Promise.all([
    db.product.count({ where }),
    db.product.findMany({
      where,
      orderBy: [{ name: "asc" }, { id: "asc" }],
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
      select: { ...PRODUCT_SELECT, units: { where: { retiredAt: null }, select: UNIT_SELECT } },
    }),
  ]);
  return { products: rows.map(productView), ...paged(total, page) };
}

const productIdSchema = z.object({ productId: z.string().uuid(PRODUCT_NOT_FOUND) });

/** One product with all its units (retired ones included) and its recent price changes. */
export async function getProduct(
  context: AppContext,
  input: unknown,
): Promise<{ product: ProductView; priceHistory: PriceChangeView[] }> {
  authorize(context, "price.view");
  const { productId } = parseInput(productIdSchema, input);
  const db = businessDb(context);

  const row = await db.product.findFirst({
    where: { id: productId },
    select: { ...PRODUCT_SELECT, units: { select: UNIT_SELECT } },
  });
  if (!row) throw new NotFoundError(PRODUCT_NOT_FOUND);

  const history = await db.priceChange.findMany({
    where: { productId },
    orderBy: { createdAt: "desc" },
    take: 50,
    select: { id: true, createdAt: true, unitName: true, oldPrice: true, newPrice: true, changedByName: true },
  });

  return {
    product: productView(row),
    priceHistory: history.map((entry) => ({
      id: entry.id,
      createdAt: entry.createdAt,
      unitName: entry.unitName,
      oldPrice: entry.oldPrice ? entry.oldPrice.toFixed(2) : null,
      newPrice: entry.newPrice ? entry.newPrice.toFixed(2) : null,
      changedByName: entry.changedByName,
    })),
  };
}

// ---------------------------------------------------------------------------
// Categories
// ---------------------------------------------------------------------------

const categoryNameSchema = z
  .string()
  .trim()
  .min(2, "Enter the category name (at least 2 characters).")
  .max(60, "The category name is too long (60 characters at most).");
const categoryIdSchema = z.string().uuid(CATEGORY_NOT_FOUND);

/** The business's categories in name order, with how many products each holds. */
export async function listCategories(context: AppContext): Promise<CategoryView[]> {
  authorize(context, "price.view");
  const rows = await businessDb(context).category.findMany({
    orderBy: { name: "asc" },
    select: { id: true, name: true, _count: { select: { products: true } } },
  });
  return rows.map((row) => ({ id: row.id, name: row.name, productCount: row._count.products }));
}

const createCategorySchema = z.object({ name: categoryNameSchema });

export async function createCategory(context: AppContext, input: unknown): Promise<{ id: string }> {
  authorize(context, "product.manage");
  const businessId = businessIdOf(context);
  const data = parseInput(createCategorySchema, input);

  try {
    return await businessDb(context).$transaction(async (tx) => {
      const category = await tx.category.create({ data: { businessId, name: data.name } });
      await tx.activityLog.create({
        data: activityRow(context, {
          action: "category.created",
          summary: `${context.actor.name} created the product category "${category.name}".`,
          targetType: "category",
          targetId: category.id,
        }),
      });
      return { id: category.id };
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new ValidationError(FIX_FIELDS, { name: "There is already a category with this name." });
    }
    throw error;
  }
}

const renameCategorySchema = z.object({ categoryId: categoryIdSchema, name: categoryNameSchema });

export async function renameCategory(context: AppContext, input: unknown): Promise<void> {
  authorize(context, "product.manage");
  const data = parseInput(renameCategorySchema, input);
  const db = businessDb(context);

  const category = await db.category.findFirst({ where: { id: data.categoryId } });
  if (!category) throw new NotFoundError(CATEGORY_NOT_FOUND);
  if (category.name === data.name) return;

  try {
    await db.$transaction(async (tx) => {
      await tx.category.update({ where: { id: category.id }, data: { name: data.name } });
      await tx.activityLog.create({
        data: activityRow(context, {
          action: "category.renamed",
          summary: `${context.actor.name} renamed the product category "${category.name}" to "${data.name}".`,
          targetType: "category",
          targetId: category.id,
        }),
      });
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new ValidationError(FIX_FIELDS, { name: "There is already a category with this name." });
    }
    throw error;
  }
}

const removeCategorySchema = z.object({ categoryId: categoryIdSchema });

/** Removes a category that has no products in it. One that is still in use must be emptied or renamed instead. */
export async function removeCategory(context: AppContext, input: unknown): Promise<void> {
  authorize(context, "product.manage");
  const data = parseInput(removeCategorySchema, input);

  await businessDb(context).$transaction(async (tx) => {
    const category = await tx.category.findFirst({
      where: { id: data.categoryId },
      select: { id: true, name: true, _count: { select: { products: true } } },
    });
    if (!category) throw new NotFoundError(CATEGORY_NOT_FOUND);
    if (category._count.products > 0) {
      throw new ValidationError(
        `"${category.name}" still has ${category._count.products} product(s) in it. Move them to another category first, or rename this one.`,
      );
    }
    // The database also refuses this if a product still points at the category.
    await tx.category.delete({ where: { id: category.id } });
    await tx.activityLog.create({
      data: activityRow(context, {
        action: "category.removed",
        summary: `${context.actor.name} removed the empty product category "${category.name}".`,
        targetType: "category",
        targetId: category.id,
      }),
    });
  });
}

/** Checks that a chosen category belongs to the business in use. Blank means "no category". */
async function resolveCategory(
  db: ReturnType<typeof businessDb>,
  categoryId: string | null,
): Promise<{ id: string; name: string } | null> {
  if (categoryId === null) return null;
  const category = await db.category.findFirst({ where: { id: categoryId }, select: { id: true, name: true } });
  if (!category) throw new ValidationError(FIX_FIELDS, { categoryId: "Choose a category from the list." });
  return category;
}

const optionalCategoryId = z
  .string()
  .trim()
  .max(40)
  .optional()
  .default("")
  .transform((value) => (value === "" ? null : value));

// ---------------------------------------------------------------------------
// Products
// ---------------------------------------------------------------------------

const productNameSchema = z
  .string()
  .trim()
  .min(2, "Enter the product name (at least 2 characters).")
  .max(120, "The product name is too long (120 characters at most).");
const unitNameSchema = z
  .string()
  .trim()
  .min(1, "Enter the unit name, for example single, pack, carton, kg or bag.")
  .max(40, "The unit name is too long (40 characters at most).");
const codeSchema = optionalText(40, "The code is too long (40 characters at most).");
const barcodeSchema = optionalText(64, "The barcode is too long (64 characters at most).");
const optionalPrice = z
  .string()
  .trim()
  .transform((value) => (value === "" ? null : value))
  .pipe(z.union([z.null(), moneyText("price")]));

const createProductSchema = z.object({
  name: productNameSchema,
  code: codeSchema,
  barcode: barcodeSchema,
  categoryId: optionalCategoryId,
  baseUnitName: unitNameSchema,
  allowsFraction: yesNo,
  taxable: yesNo,
  tracksBatch: yesNo.optional().default(false),
  tracksExpiry: yesNo.optional().default(false),
  baseForSale: yesNo,
  basePrice: optionalPrice,
});

async function assertProductDetailsFree(
  db: ReturnType<typeof businessDb>,
  details: { name: string; code: string | null; barcode: string | null },
  exceptProductId?: string,
) {
  const clashes = await db.product.findMany({
    where: {
      ...(exceptProductId ? { id: { not: exceptProductId } } : {}),
      OR: [
        { name: details.name },
        ...(details.code ? [{ code: details.code }] : []),
        ...(details.barcode ? [{ barcode: details.barcode }] : []),
      ],
    },
    select: { name: true, code: true, barcode: true },
  });
  const fieldErrors: Record<string, string> = {};
  const same = (a: string | null, b: string | null) => !!a && !!b && a.toLowerCase() === b.toLowerCase();
  for (const clash of clashes) {
    if (same(clash.name, details.name)) fieldErrors.name = "Another product already has this name.";
    if (same(clash.code, details.code)) fieldErrors.code = "Another product already has this code.";
    if (same(clash.barcode, details.barcode)) fieldErrors.barcode = "Another product already has this barcode.";
  }
  if (Object.keys(fieldErrors).length > 0) throw new ValidationError(FIX_FIELDS, fieldErrors);
}

/** Creates a product together with its base unit — both, or neither. */
export async function createProduct(context: AppContext, input: unknown): Promise<{ id: string }> {
  authorize(context, "product.manage");
  const businessId = businessIdOf(context);
  const data = parseInput(createProductSchema, input);
  if (data.baseForSale) {
    authorize(context, "price.manage");
    if (data.basePrice === null) {
      throw new ValidationError(FIX_FIELDS, { basePrice: "Enter the selling price of the base unit." });
    }
  }
  const price = data.baseForSale ? data.basePrice : null;
  const db = businessDb(context);
  await assertProductDetailsFree(db, data);
  const category = await resolveCategory(db, data.categoryId);

  try {
    return await db.$transaction(async (tx) => {
      const product = await tx.product.create({
        data: {
          businessId,
          name: data.name,
          code: data.code,
          barcode: data.barcode,
          categoryId: category?.id ?? null,
          allowsFraction: data.allowsFraction,
          taxable: data.taxable,
          tracksBatch: data.tracksBatch,
          tracksExpiry: data.tracksExpiry,
        },
      });
      const unit = await tx.productUnit.create({
        data: {
          businessId,
          productId: product.id,
          name: data.baseUnitName,
          activeName: data.baseUnitName,
          factor: "1",
          isBase: true,
          forSale: data.baseForSale,
          forPurchase: true,
          price,
        },
      });
      if (price !== null) {
        await tx.priceChange.create({
          data: {
            businessId,
            productId: product.id,
            productUnitId: unit.id,
            unitName: unit.name,
            oldPrice: null,
            newPrice: price,
            changedByUserId: context.actor.userId,
            changedByName: context.actor.name,
          },
        });
      }
      await tx.activityLog.create({
        data: activityRow(context, {
          action: "product.created",
          summary: `${context.actor.name} created the product "${product.name}" (base unit: ${unit.name}).`,
          targetType: "product",
          targetId: product.id,
        }),
      });
      return { id: product.id };
    });
  } catch (error) {
    // Reached only if two requests raced past the check above.
    if (isUniqueViolation(error)) {
      throw new ValidationError("A product with this name, code or barcode was created a moment ago. Nothing was saved this time.");
    }
    throw error;
  }
}

const updateProductSchema = z.object({
  productId: z.string().uuid(PRODUCT_NOT_FOUND),
  name: productNameSchema,
  code: codeSchema,
  barcode: barcodeSchema,
  categoryId: optionalCategoryId,
  taxable: yesNo,
  tracksBatch: yesNo.optional(),
  tracksExpiry: yesNo.optional(),
});

/** Changes a product's name, code, barcode, category or taxable tick. The base unit and "sold by" never change. */
export async function updateProduct(context: AppContext, input: unknown): Promise<void> {
  authorize(context, "product.manage");
  const data = parseInput(updateProductSchema, input);
  const db = businessDb(context);

  const product = await db.product.findFirst({ where: { id: data.productId } });
  if (!product) throw new NotFoundError(PRODUCT_NOT_FOUND);
  await assertProductDetailsFree(db, data, product.id);
  const category = await resolveCategory(db, data.categoryId);

  const changes: string[] = [];
  if (product.name !== data.name) changes.push(`name to "${data.name}"`);
  if (product.code !== data.code) changes.push(`code to ${data.code ? `"${data.code}"` : "none"}`);
  if (product.barcode !== data.barcode) changes.push(`barcode to ${data.barcode ? `"${data.barcode}"` : "none"}`);
  if (product.categoryId !== (category?.id ?? null)) {
    changes.push(category ? `category to "${category.name}"` : "category to none");
  }
  if (product.taxable !== data.taxable) changes.push(data.taxable ? "marked as taxable" : "marked as not taxable");
  const tracksBatch = data.tracksBatch ?? product.tracksBatch;
  const tracksExpiry = data.tracksExpiry ?? product.tracksExpiry;
  if (product.tracksBatch !== tracksBatch) changes.push(tracksBatch ? "now uses batch numbers" : "no longer uses batch numbers");
  if (product.tracksExpiry !== tracksExpiry) changes.push(tracksExpiry ? "now uses expiry dates" : "no longer uses expiry dates");
  if (changes.length === 0) return;

  try {
    await db.$transaction(async (tx) => {
      await tx.product.update({
        where: { id: product.id },
        data: {
          name: data.name,
          code: data.code,
          barcode: data.barcode,
          categoryId: category?.id ?? null,
          taxable: data.taxable,
          tracksBatch,
          tracksExpiry,
        },
      });
      await tx.activityLog.create({
        data: activityRow(context, {
          action: "product.updated",
          summary: `${context.actor.name} changed the product "${product.name}": ${changes.join(", ")}.`,
          targetType: "product",
          targetId: product.id,
        }),
      });
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new ValidationError("Another product took this name, code or barcode a moment ago. Nothing was saved this time.");
    }
    throw error;
  }
}

const setProductActiveSchema = z.object({ productId: z.string().uuid(PRODUCT_NOT_FOUND), active: z.boolean() });

/** Takes a product out of use, or brings it back. Products are never deleted. */
export async function setProductActive(context: AppContext, input: unknown): Promise<void> {
  authorize(context, "product.manage");
  const data = parseInput(setProductActiveSchema, input);

  await businessDb(context).$transaction(async (tx) => {
    const product = await tx.product.findFirst({ where: { id: data.productId } });
    if (!product) throw new NotFoundError(PRODUCT_NOT_FOUND);
    if ((product.deactivatedAt === null) === data.active) return;

    await tx.product.update({
      where: { id: product.id },
      data: { deactivatedAt: data.active ? null : new Date() },
    });
    await tx.activityLog.create({
      data: activityRow(context, {
        action: data.active ? "product.reactivated" : "product.deactivated",
        summary: `${context.actor.name} ${data.active ? "brought back" : "took out of use"} the product "${product.name}".`,
        targetType: "product",
        targetId: product.id,
      }),
    });
  });
}

// ---------------------------------------------------------------------------
// Units
// ---------------------------------------------------------------------------

const addUnitSchema = z.object({
  productId: z.string().uuid(PRODUCT_NOT_FOUND),
  name: unitNameSchema,
  factor: factorText("how many base units it contains"),
  forSale: yesNo,
  forPurchase: yesNo,
  price: optionalPrice,
});

/** Adds a unit such as "pack = 10 singles" or "bag = 50 kg", with its own price. */
export async function addUnit(context: AppContext, input: unknown): Promise<{ id: string }> {
  authorize(context, "product.manage");
  const businessId = businessIdOf(context);
  const data = parseInput(addUnitSchema, input);
  if (data.forSale) authorize(context, "price.manage");

  const fieldErrors: Record<string, string> = {};
  if (!data.forSale && !data.forPurchase) {
    fieldErrors.forSale = "Tick at least one: used for selling, or used for buying.";
  }
  if (data.forSale && data.price === null) {
    fieldErrors.price = "Enter the selling price for this unit.";
  }
  const factor = new Decimal(data.factor);
  if (factor.equals(1)) {
    fieldErrors.factor = "The base unit is already 1. Give a different amount, for example 10 for a pack of ten.";
  }

  const db = businessDb(context);
  const product = await db.product.findFirst({
    where: { id: data.productId },
    select: { id: true, name: true, allowsFraction: true, deactivatedAt: true },
  });
  if (!product) throw new NotFoundError(PRODUCT_NOT_FOUND);
  if (product.deactivatedAt) {
    throw new ValidationError("This product is out of use. Bring it back before adding units.");
  }
  if (!product.allowsFraction && !factor.isInteger()) {
    fieldErrors.factor = "This product is sold in whole units only, so a unit must contain a whole number of base units.";
  }
  if (Object.keys(fieldErrors).length > 0) throw new ValidationError(FIX_FIELDS, fieldErrors);

  const price = data.forSale ? data.price : null;
  try {
    return await db.$transaction(async (tx) => {
      const unit = await tx.productUnit.create({
        data: {
          businessId,
          productId: product.id,
          name: data.name,
          activeName: data.name,
          factor: data.factor,
          isBase: false,
          forSale: data.forSale,
          forPurchase: data.forPurchase,
          price,
        },
      });
      if (price !== null) {
        await tx.priceChange.create({
          data: {
            businessId,
            productId: product.id,
            productUnitId: unit.id,
            unitName: unit.name,
            oldPrice: null,
            newPrice: price,
            changedByUserId: context.actor.userId,
            changedByName: context.actor.name,
          },
        });
      }
      await tx.activityLog.create({
        data: activityRow(context, {
          action: "product.unit_added",
          summary: `${context.actor.name} added the unit "${unit.name}" (${factor.toString()} base units) to "${product.name}".`,
          targetType: "product",
          targetId: product.id,
        }),
      });
      return { id: unit.id };
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new ValidationError(FIX_FIELDS, { name: "This product already has a unit with that name." });
    }
    throw error;
  }
}

const unitIdSchema = z.string().uuid(UNIT_NOT_FOUND);

async function findUnit(db: ReturnType<typeof businessDb>, unitId: string) {
  const unit = await db.productUnit.findFirst({
    where: { id: unitId },
    select: { ...UNIT_SELECT, productId: true, product: { select: { name: true, deactivatedAt: true } } },
  });
  if (!unit) throw new NotFoundError(UNIT_NOT_FOUND);
  return unit;
}

const setUnitPriceSchema = z.object({ unitId: unitIdSchema, price: moneyText("price") });

/** Changes one unit's selling price and records the old and new price. */
export async function setUnitPrice(context: AppContext, input: unknown): Promise<void> {
  authorize(context, "price.manage");
  const businessId = businessIdOf(context);
  const data = parseInput(setUnitPriceSchema, input);
  const db = businessDb(context);

  const unit = await findUnit(db, data.unitId);
  if (unit.retiredAt) throw new ValidationError("This unit has been retired and can no longer be priced.");
  if (!unit.forSale) throw new ValidationError("This unit is not for sale. Mark it for sale first.");

  const newPrice = new Decimal(data.price);
  const oldPrice = unit.price ? new Decimal(unit.price.toFixed(2)) : null;
  if (oldPrice && oldPrice.equals(newPrice)) return; // Nothing to change.

  await db.$transaction(async (tx) => {
    // Only succeeds if the price is still what this person saw; otherwise someone else just changed it.
    const updated = await tx.productUnit.updateMany({
      where: { id: unit.id, price: unit.price, retiredAt: null },
      data: { price: data.price },
    });
    if (updated.count !== 1) {
      throw new ValidationError("Someone else changed this price a moment ago. Check the current price and try again.");
    }
    await tx.priceChange.create({
      data: {
        businessId,
        productId: unit.productId,
        productUnitId: unit.id,
        unitName: unit.name,
        oldPrice: unit.price,
        newPrice: data.price,
        changedByUserId: context.actor.userId,
        changedByName: context.actor.name,
      },
    });
    await tx.activityLog.create({
      data: activityRow(context, {
        action: "price.changed",
        summary: `${context.actor.name} changed the price of "${unit.product.name}" per ${unit.name} from ${oldPrice ? formatNaira(oldPrice) : "none"} to ${formatNaira(newPrice)}.`,
        targetType: "product",
        targetId: unit.productId,
        details: { unit: unit.name, from: oldPrice ? oldPrice.toFixed(2) : null, to: newPrice.toFixed(2) },
      }),
    });
  });
}

const setUnitUsageSchema = z.object({
  unitId: unitIdSchema,
  forSale: yesNo,
  forPurchase: yesNo,
  price: optionalPrice,
});

/** Says whether a unit is used for selling, for buying, or both. Marking it for sale needs a price. */
export async function setUnitUsage(context: AppContext, input: unknown): Promise<void> {
  authorize(context, "product.manage");
  const businessId = businessIdOf(context);
  const data = parseInput(setUnitUsageSchema, input);
  const db = businessDb(context);

  const unit = await findUnit(db, data.unitId);
  if (unit.retiredAt) throw new ValidationError("This unit has been retired.");
  if (!data.forSale && !data.forPurchase) {
    throw new ValidationError(
      unit.isBase
        ? "The base unit must be used for selling or buying."
        : "A unit must be used for selling or buying. To stop using it altogether, retire it.",
    );
  }
  if (unit.forSale === data.forSale && unit.forPurchase === data.forPurchase) return;

  const needsFirstPrice = data.forSale && unit.price === null;
  if (needsFirstPrice) {
    authorize(context, "price.manage");
    if (data.price === null) {
      throw new ValidationError(FIX_FIELDS, { price: "Enter the selling price for this unit." });
    }
  }

  await db.$transaction(async (tx) => {
    await tx.productUnit.update({
      where: { id: unit.id },
      data: {
        forSale: data.forSale,
        forPurchase: data.forPurchase,
        ...(needsFirstPrice ? { price: data.price } : {}),
      },
    });
    if (needsFirstPrice) {
      await tx.priceChange.create({
        data: {
          businessId,
          productId: unit.productId,
          productUnitId: unit.id,
          unitName: unit.name,
          oldPrice: null,
          newPrice: data.price,
          changedByUserId: context.actor.userId,
          changedByName: context.actor.name,
        },
      });
    }
    const uses = [data.forSale ? "selling" : null, data.forPurchase ? "buying" : null].filter(Boolean).join(" and ");
    await tx.activityLog.create({
      data: activityRow(context, {
        action: "product.unit_usage_changed",
        summary: `${context.actor.name} set the unit "${unit.name}" of "${unit.product.name}" to be used for ${uses}.`,
        targetType: "product",
        targetId: unit.productId,
      }),
    });
  });
}

const retireUnitSchema = z.object({ unitId: unitIdSchema });

/** Stops a unit being used. Its past records keep their meaning; a new unit may reuse the name. */
export async function retireUnit(context: AppContext, input: unknown): Promise<void> {
  authorize(context, "product.manage");
  const data = parseInput(retireUnitSchema, input);
  const db = businessDb(context);

  const unit = await findUnit(db, data.unitId);
  if (unit.isBase) throw new ValidationError("The base unit cannot be retired. Take the whole product out of use instead.");
  if (unit.retiredAt) return;

  await db.$transaction(async (tx) => {
    await tx.productUnit.update({
      where: { id: unit.id },
      data: { retiredAt: new Date(), activeName: null },
    });
    await tx.activityLog.create({
      data: activityRow(context, {
        action: "product.unit_retired",
        summary: `${context.actor.name} retired the unit "${unit.name}" of "${unit.product.name}".`,
        targetType: "product",
        targetId: unit.productId,
      }),
    });
  });
}
