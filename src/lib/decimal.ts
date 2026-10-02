import DecimalJs from "decimal.js";

/**
 * The one Decimal class used for all money and quantity maths in KuchPos.
 * Never use JavaScript `number` arithmetic for money or quantities.
 */
export const Decimal = DecimalJs.clone({
  precision: 40,
  rounding: DecimalJs.ROUND_HALF_UP,
});

export type Decimal = InstanceType<typeof Decimal>;

/** Plain decimal text only: no exponents, no signs other than a leading minus, no spaces. */
const DECIMAL_TEXT = /^-?\d+(\.\d+)?$/;

export class InvalidDecimalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidDecimalError";
  }
}

/**
 * Parses decimal text exactly. Rejects anything that is not plain decimal text,
 * and anything with more decimal places than allowed (it never rounds silently).
 */
export function parseDecimal(
  value: string,
  maxDecimalPlaces: number,
  label: string,
): Decimal {
  if (typeof value !== "string") {
    throw new InvalidDecimalError(`${label} must be given as text, not a number.`);
  }
  const text = value.trim();
  if (!DECIMAL_TEXT.test(text)) {
    throw new InvalidDecimalError(`${label} "${value}" is not a valid number.`);
  }
  const parsed = new Decimal(text);
  if (parsed.decimalPlaces() > maxDecimalPlaces) {
    throw new InvalidDecimalError(
      `${label} "${value}" has more than ${maxDecimalPlaces} decimal places.`,
    );
  }
  return parsed;
}
