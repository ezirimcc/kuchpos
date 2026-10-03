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
