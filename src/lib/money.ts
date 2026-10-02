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
