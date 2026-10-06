import "server-only";
import { z } from "zod";
import { Decimal } from "@/lib/decimal";
import { dateToDay, dayToDate } from "@/lib/format";
import { lineTotal, moneyToString, parseMoney } from "@/lib/money";
import { parseQuantity, quantityToString, toBaseQuantity } from "@/lib/quantity";
import type { businessDb } from "@/server/db/scoped";
import { optionalText } from "@/server/input";

/**
 * Checking the lines of a delivery. Shared by "receive goods" and "correct a delivery",
 * so both apply exactly the same rules. Not an operation: callers have already checked
 * who is asking, and pass in their business-scoped database client.
 */

export const MAX_LINES = 200;
const MAX_UNIT_QUANTITY = new Decimal("9999999.999");
const MAX_BASE_QUANTITY = new Decimal("999999999.999");
const MAX_UNIT_COST = new Decimal("999999999.99");

export const lineSchema = z.object({
  productId: z.string().trim(),
  unitId: z.string().trim(),
  quantity: z.string().trim(),
  unitCost: z.string().trim(),
  batchNumber: optionalText(60, "The batch number is too long (60 characters at most).").optional().default(""),
  expiryDate: z.string().trim().optional().default(""),
});

export type LineInput = z.infer<typeof lineSchema>;

export type CheckedLine = {
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

/** A line already on the delivery being corrected: its copies of names and conversion are kept. */
export type SavedLine = {
  productId: string;
  productUnitId: string;
  productName: string;
  unitName: string;
  unitFactor: string;
  batchNumber: string | null;
  expiryDate: Date | null;
};

/**
 * Checks every line and returns one result per line, in order (`null` where the line has a
 * problem, which is then described in `fieldErrors` under `lines.N.field`).
 *
 * `savedLineFor` says which lines already exist on the delivery. For those, whatever is left
 * as it was is accepted as it was — even if the product has since been taken out of use, its
 * unit retired, or its batch/expiry settings changed. Anything that is changed must pass
 * today's rules.
 */
export async function checkLines(
  db: ReturnType<typeof businessDb>,
  lines: LineInput[],
  fieldErrors: Record<string, string>,
  savedLineFor: (index: number) => SavedLine | undefined = () => undefined,
): Promise<(CheckedLine | null)[]> {
  const productIds = [...new Set(lines.map((line) => line.productId).filter(Boolean))];
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

  return lines.map((line, index) => {
    const at = (field: string) => `lines.${index}.${field}`;
    const saved = savedLineFor(index);
    const product = productById.get(line.productId);
    if (!product) {
      fieldErrors[at("productId")] = "Choose a product.";
      return null;
    }
    if (saved && saved.productId !== product.id) {
      fieldErrors[at("productId")] = "A line's product cannot be changed. Remove this line and add a new one instead.";
      return null;
    }
    if (!saved && product.deactivatedAt) {
      fieldErrors[at("productId")] = `"${product.name}" is out of use and cannot be received.`;
      return null;
    }

    let unitName: string;
    let unitFactor: string;
    if (saved && saved.productUnitId === line.unitId) {
      unitName = saved.unitName;
      unitFactor = saved.unitFactor;
    } else {
      const unit = product.units.find((candidate) => candidate.id === line.unitId);
      if (!unit || unit.retiredAt || !unit.forPurchase) {
        fieldErrors[at("unitId")] = "Choose a unit this product is bought in.";
        return null;
      }
      unitName = unit.name;
      unitFactor = unit.factor.toFixed(3);
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
        baseQuantity = toBaseQuantity(quantity, new Decimal(unitFactor));
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
    const batchUntouched = saved !== undefined && saved.batchNumber === batchNumber;
    if (!batchUntouched) {
      if (product.tracksBatch && !batchNumber) {
        fieldErrors[at("batchNumber")] = `"${product.name}" needs a batch number.`;
      } else if (!product.tracksBatch && batchNumber) {
        fieldErrors[at("batchNumber")] = `"${product.name}" is not set up to use batch numbers.`;
      }
    }

    let expiryDate: Date | null = null;
    const savedExpiry = saved?.expiryDate ? dateToDay(saved.expiryDate) : "";
    if (saved !== undefined && savedExpiry === line.expiryDate) {
      expiryDate = saved.expiryDate;
    } else if (product.tracksExpiry) {
      expiryDate = dayToDate(line.expiryDate);
      if (!expiryDate) fieldErrors[at("expiryDate")] = `"${product.name}" needs an expiry date.`;
    } else if (line.expiryDate !== "") {
      fieldErrors[at("expiryDate")] = `"${product.name}" is not set up to use expiry dates.`;
    }

    if (!quantity || !baseQuantity || !unitCost) return null;
    return {
      productId: product.id,
      productUnitId: line.unitId,
      productName: saved ? saved.productName : product.name,
      unitName,
      unitFactor,
      quantity: quantityToString(quantity),
      baseQuantity,
      unitCost: moneyToString(unitCost),
      lineCost: lineTotal(quantity, unitCost),
      batchNumber,
      expiryDate,
    };
  });
}
