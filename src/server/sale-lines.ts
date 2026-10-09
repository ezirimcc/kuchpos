import "server-only";
import { createHash } from "node:crypto";
import { z } from "zod";
import { Decimal } from "@/lib/decimal";
import { formatNaira, lineTotal, moneyToString, parseMoney, percentOf } from "@/lib/money";
import { parseQuantity, quantityToString, toBaseQuantity } from "@/lib/quantity";
import type { AppContext } from "@/server/auth/context";
import type { businessDb } from "@/server/db/scoped";
import { ValidationError } from "@/server/errors";
import { can } from "@/server/permissions";

/**
 * Checking the lines of a sale against the server's own products, units and prices.
 * Shared by `postSale` (saving the sale) and by approvals (a manager approves exactly these
 * lines), so both see the sale the same way. Not an operation: callers have already
 * checked who is asking, and pass in their business-scoped database client.
 */

export const MAX_SALE_LINES = 200;
const MAX_UNIT_QUANTITY = new Decimal("9999999.999");
const MAX_BASE_QUANTITY = new Decimal("999999999.999");
const MAX_MONEY = new Decimal("99999999999.99");

export const saleLinesSchema = z
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
  .max(MAX_SALE_LINES, `A sale can have at most ${MAX_SALE_LINES} lines.`);

export type SaleLineInput = z.infer<typeof saleLinesSchema>[number];

export type CheckedSaleLine = {
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
  /** Offline sales only: what was found that a manager should look at (price not the current one, out of use). */
  notes?: { kind: "PRICE_DIFFERENT" | "OUT_OF_USE"; summary: string }[];
};

/**
 * Checks every line and returns the sound ones; problems are written into `fieldErrors`
 * under `lines.N.field`. The price is always the server's own: what the cashier saw is
 * only compared with it. Also returns the business's locations, which callers need.
 */
export async function checkSaleLines(
  db: ReturnType<typeof businessDb>,
  context: AppContext,
  lines: SaleLineInput[],
  fieldErrors: Record<string, string>,
  /**
   * For a sale made offline, hours ago, on the checkout computer: the goods have left the
   * shop, so the price the cashier saw is the price, and a product or unit taken out of use
   * since is still accepted. Each such thing is noted on the line instead of refused.
   */
  options: { madeOffline?: boolean } = {},
): Promise<{ checked: CheckedSaleLine[]; locations: { id: string; name: string; kind: "SHELF" | "STOREROOM" }[] }> {
  const locations = await db.location.findMany({ select: { id: true, name: true, kind: true } });
  const shelf = locations.find((location) => location.kind === "SHELF");
  const storeroom = locations.find((location) => location.kind === "STOREROOM");
  if (!shelf) throw new ValidationError("This business has no Shelf to sell from. Ask the admin to check the locations.");
  const mayUseStoreroom = can(context, "sale.fromStoreroom");

  const productIds = [...new Set(lines.map((line) => line.productId).filter(Boolean))];
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

  const checked: CheckedSaleLine[] = [];
  lines.forEach((line, index) => {
    const at = (field: string) => `lines.${index}.${field}`;
    const product = productById.get(line.productId);
    if (!product) {
      fieldErrors[at("productId")] = "This product could not be found. Remove the line and add it again.";
      return;
    }
    const notes: NonNullable<CheckedSaleLine["notes"]> = [];
    if (product.deactivatedAt) {
      if (!options.madeOffline) {
        fieldErrors[at("productId")] = `"${product.name}" is no longer on sale. Remove this line.`;
        return;
      }
      notes.push({ kind: "OUT_OF_USE", summary: `"${product.name}" had been taken off sale.` });
    }
    const unit = product.units.find((candidate) => candidate.id === line.unitId);
    const unitOnSale = !!unit && !unit.retiredAt && unit.forSale && unit.price !== null;
    if (!unit || (!unitOnSale && !options.madeOffline)) {
      fieldErrors[at("unitId")] = `"${product.name}" is no longer sold in that unit. Reload the page to get the latest products.`;
      return;
    }
    if (!unitOnSale) notes.push({ kind: "OUT_OF_USE", summary: `"${product.name}" was no longer sold by the ${unit.name}.` });

    let location = shelf;
    if (line.fromStoreroom) {
      if (!mayUseStoreroom || !storeroom) {
        fieldErrors[at("fromStoreroom")] = "Only a manager or admin can sell straight from the Storeroom.";
        return;
      }
      location = storeroom;
    }

    const current = unit.price === null ? null : new Decimal(unit.price.toFixed(2));
    let seen: Decimal | null = null;
    try {
      seen = parseMoney(line.unitPrice);
      if (seen.isNegative() || seen.greaterThan(MAX_MONEY)) seen = null;
    } catch {
      seen = null;
    }
    let price = current ?? new Decimal(0);
    if (options.madeOffline) {
      if (!seen) {
        fieldErrors[at("unitPrice")] = `The price charged for ${product.name} (${unit.name}) is missing.`;
        return;
      }
      if (!current || !seen.equals(current)) {
        notes.push({
          kind: "PRICE_DIFFERENT",
          summary:
            `${product.name} (${unit.name}) was sold at ${formatNaira(seen)}` +
            (current ? `; the price set when the sale arrived was ${formatNaira(current)}.` : "; it had no price when the sale arrived."),
        });
      }
      price = seen;
    } else if (!seen || !current || !seen.equals(price)) {
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
        ...(notes.length > 0 ? { notes } : {}),
      });
    } catch {
      fieldErrors[at("quantity")] = "Enter how many, as a number greater than zero (up to 3 decimal places).";
    }
  });

  return { checked, locations };
}

/** How long an approval is good for once given (SPEC §4.5). */
export const APPROVAL_MINUTES = 10;

/**
 * Checks an extra discount against what the items come to. The Naira amount is what counts;
 * a percentage is kept only if it really gives that amount. Problems go into `fieldErrors`
 * under `discount.amount` / `discount.percent`, and the discount then comes back as zero.
 */
export function checkDiscount(
  subtotal: Decimal,
  typed: { amount: string; percent: string },
  fieldErrors: Record<string, string>,
): { discount: Decimal; percent: Decimal | null } {
  const none = { discount: new Decimal(0), percent: null };
  let discount: Decimal;
  try {
    discount = parseMoney(typed.amount);
    if (!discount.greaterThan(0)) throw new Error("out of range");
  } catch {
    fieldErrors["discount.amount"] = "Enter the discount as a plain amount greater than zero, for example 500 (no commas).";
    return none;
  }
  if (discount.greaterThan(subtotal)) {
    fieldErrors["discount.amount"] = `The discount cannot be more than the ${formatNaira(subtotal)} the items come to.`;
    return none;
  }
  if (typed.percent === "") return { discount, percent: null };
  const percent = /^\d{1,3}(\.\d{1,2})?$/.test(typed.percent) ? new Decimal(typed.percent) : null;
  if (!percent || !percent.greaterThan(0) || percent.greaterThan(100) || !percentOf(subtotal, percent).equals(discount)) {
    fieldErrors["discount.percent"] = "The discount does not match its percentage. Enter the discount again.";
    return none;
  }
  return { discount, percent };
}

function fingerprint(parts: string[]): string {
  return createHash("sha256").update(parts.join("\n")).digest("hex");
}

/**
 * A fingerprint of a discount on a sale: this sale, exactly these items in this order at
 * these prices, and exactly this discount. Change any of it and the fingerprint changes,
 * so an approval given for one cannot be used for another.
 */
export function discountFingerprint(saleRequestId: string, lines: CheckedSaleLine[], discount: Decimal): string {
  return fingerprint([
    "discount",
    saleRequestId,
    moneyToString(discount),
    ...lines.map((line) => [line.productId, line.productUnitId, line.quantity, moneyToString(line.unitPrice), line.location.id].join("|")),
  ]);
}

/** A fingerprint of putting this amount on this customer's account in this sale. */
export function creditFingerprint(saleRequestId: string, customerId: string, credit: Decimal): string {
  return fingerprint(["credit", saleRequestId, customerId, moneyToString(credit)]);
}
