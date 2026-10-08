import { Decimal, InvalidDecimalError, parseDecimal } from "./decimal";

/** Naira amounts are kept to the kobo: two decimal places. */
export const MONEY_DECIMAL_PLACES = 2;

/** Parses a Naira amount given as text, e.g. "1250.50". Rejects more than 2 decimal places. */
export function parseMoney(value: string, label = "Amount"): Decimal {
  return parseDecimal(value, MONEY_DECIMAL_PLACES, label);
}

/** Rounds to the nearest kobo; exactly half a kobo rounds away from zero. */
export function roundMoney(amount: Decimal): Decimal {
  return amount.toDecimalPlaces(MONEY_DECIMAL_PLACES, Decimal.ROUND_HALF_UP);
}

/** Text form for storing and sending over the network, always with 2 decimal places: "1250.50". */
export function moneyToString(amount: Decimal): string {
  return roundMoney(amount).toFixed(MONEY_DECIMAL_PLACES);
}

/** Display form: "₦1,250.50". */
export function formatNaira(amount: Decimal): string {
  const rounded = roundMoney(amount);
  const [whole, kobo] = rounded.abs().toFixed(MONEY_DECIMAL_PLACES).split(".");
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${rounded.isNegative() ? "-" : ""}₦${grouped}.${kobo}`;
}

/** Line total = quantity × unit price, rounded to the kobo. */
export function lineTotal(quantity: Decimal, unitPrice: Decimal): Decimal {
  return roundMoney(quantity.times(unitPrice));
}

/** Sale total = the sum of already-rounded line totals. */
export function sumMoney(amounts: Decimal[]): Decimal {
  return amounts.reduce((total, amount) => total.plus(amount), new Decimal(0));
}

/**
 * Tax contained in a tax-inclusive amount.
 * tax = amount × rate ÷ (100 + rate), rounded to the kobo.
 * Example: ₦1,075.00 at 7.5% contains ₦75.00 tax.
 */
export function taxIncludedIn(amount: Decimal, ratePercent: Decimal): Decimal {
  if (ratePercent.isNegative()) {
    throw new InvalidDecimalError("Tax rate cannot be negative.");
  }
  if (ratePercent.isZero()) return new Decimal(0);
  return roundMoney(amount.times(ratePercent).dividedBy(ratePercent.plus(100)));
}

/** Average cost of one base unit is kept to four decimal places, so small units stay accurate. */
export const COST_DECIMAL_PLACES = 4;

export function roundCost(amount: Decimal): Decimal {
  return amount.toDecimalPlaces(COST_DECIMAL_PLACES, Decimal.ROUND_HALF_UP);
}

/**
 * Moving weighted average cost of one base unit after a delivery.
 * (stock before × old average + cost of the delivery) ÷ (stock before + quantity delivered).
 * With no stock before, the new average is simply the delivery's own cost per base unit.
 */
export function movingAverageCost(input: {
  quantityBefore: Decimal;
  averageBefore: Decimal;
  quantityAdded: Decimal;
  costAdded: Decimal;
}): Decimal {
  const { quantityBefore, averageBefore, quantityAdded, costAdded } = input;
  if (!quantityAdded.greaterThan(0)) return roundCost(averageBefore);
  if (!quantityBefore.greaterThan(0)) return roundCost(costAdded.dividedBy(quantityAdded));
  return roundCost(
    quantityBefore.times(averageBefore).plus(costAdded).dividedBy(quantityBefore.plus(quantityAdded)),
  );
}

/**
 * Average cost of one base unit after a saved delivery is corrected.
 *
 * The delivery used to bring in `oldQuantity` costing `oldCost`; it should have brought in
 * `newQuantity` costing `newCost`. Units added or taken away change the stock's value at the
 * delivery's own cost per unit. A change of price re-values only the part of the delivery
 * that can still be in stock: goods that have already left went out at the old cost, and
 * that history is not rewritten. With nothing left in stock the average stays as it is.
 */
export function correctedAverageCost(input: {
  quantityNow: Decimal;
  averageNow: Decimal;
  oldQuantity: Decimal;
  oldCost: Decimal;
  newQuantity: Decimal;
  newCost: Decimal;
}): Decimal {
  const { quantityNow, averageNow, oldQuantity, oldCost, newQuantity, newCost } = input;
  const quantityAfter = quantityNow.plus(newQuantity).minus(oldQuantity);
  if (!quantityAfter.greaterThan(0)) return roundCost(averageNow);

  const zero = new Decimal(0);
  const oldEach = oldQuantity.greaterThan(0) ? oldCost.dividedBy(oldQuantity) : zero;
  const newEach = newQuantity.greaterThan(0) ? newCost.dividedBy(newQuantity) : zero;
  const quantityPart = newQuantity.minus(oldQuantity).times(newQuantity.greaterThan(oldQuantity) ? newEach : oldEach);
  const stillInStock = Decimal.min(oldQuantity, newQuantity, quantityAfter);
  const pricePart = stillInStock.times(newEach.minus(oldEach));
  const value = quantityNow.times(averageNow).plus(quantityPart).plus(pricePart);
  return roundCost(Decimal.max(value, zero).dividedBy(quantityAfter));
}

/**
 * Shares a discount on a whole sale out over its lines, in proportion to each line's total,
 * so that each line knows what was really charged for it (for tax and for profit).
 * Each share is rounded to the kobo; the last line that has any total takes whatever is left
 * over, so the shares always add up to exactly the discount. No share exceeds its line.
 */
export function shareDiscount(lineTotals: Decimal[], discount: Decimal): Decimal[] {
  const subtotal = sumMoney(lineTotals);
  if (discount.isNegative() || discount.greaterThan(subtotal)) {
    throw new InvalidDecimalError("A discount cannot be negative or more than the total of the lines.");
  }
  const zero = new Decimal(0);
  if (discount.isZero()) return lineTotals.map(() => zero);

  let last = -1;
  lineTotals.forEach((total, index) => {
    if (total.greaterThan(0)) last = index;
  });
  let left = discount;
  return lineTotals.map((total, index) => {
    if (index === last) return left;
    // Never more than the line, and never more than is left to share.
    const share = Decimal.min(roundMoney(discount.times(total).dividedBy(subtotal)), total, left);
    left = left.minus(share);
    return share;
  });
}

/** A percentage of an amount, rounded to the kobo: 5% of ₦10,000.00 is ₦500.00. */
export function percentOf(amount: Decimal, percent: Decimal): Decimal {
  return roundMoney(amount.times(percent).dividedBy(100));
}
