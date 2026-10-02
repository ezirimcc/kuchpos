import { Decimal, InvalidDecimalError, parseDecimal } from "./decimal";

/** Quantities and unit conversions are kept to 3 decimal places (kilograms to the gram). */
export const QUANTITY_DECIMAL_PLACES = 3;

/** Parses a quantity given as text, e.g. "2.5". Rejects more than 3 decimal places. */
export function parseQuantity(value: string, label = "Quantity"): Decimal {
  return parseDecimal(value, QUANTITY_DECIMAL_PLACES, label);
}

/** Text form for storing and sending over the network, always with 3 decimal places: "2.500". */
export function quantityToString(quantity: Decimal): string {
  return quantity.toFixed(QUANTITY_DECIMAL_PLACES);
}

/**
 * Converts a quantity in a chosen unit into base units.
 * `factor` is how many base units one of the chosen unit contains (carton = 100, bag = 50).
 * The result must be exact to 3 decimal places; it is never rounded.
 */
export function toBaseQuantity(quantity: Decimal, factor: Decimal): Decimal {
  if (!factor.greaterThan(0)) {
    throw new InvalidDecimalError("A unit conversion must be greater than zero.");
  }
  const base = quantity.times(factor);
  if (base.decimalPlaces() > QUANTITY_DECIMAL_PLACES) {
    throw new InvalidDecimalError(
      `${quantity.toString()} × ${factor.toString()} cannot be held exactly to ${QUANTITY_DECIMAL_PLACES} decimal places.`,
    );
  }
  return base;
}

/** True when the quantity has no fractional part (for products sold in whole units only). */
export function isWholeQuantity(quantity: Decimal): boolean {
  return quantity.isInteger();
}
