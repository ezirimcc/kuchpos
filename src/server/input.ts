import { z } from "zod";
import { Decimal, InvalidDecimalError } from "@/lib/decimal";
import { moneyToString, parseMoney } from "@/lib/money";
import { parseQuantity, quantityToString } from "@/lib/quantity";

/**
 * Zod pieces for values typed into forms. Money and quantities arrive as text and
 * leave as exact decimal text — never as JavaScript numbers (CLAUDE.md rule 5).
 * Bad input is rejected with a plain message, never silently corrected.
 */

const MAX_MONEY = new Decimal("999999999999.99");
const MAX_FACTOR = new Decimal("999999.999");

/** A Naira amount, zero or more, at most two decimal places. Output: "1250.50". */
export function moneyText(label: string) {
  return z
    .string()
    .trim()
    .transform((value, context) => {
      try {
        const amount = parseMoney(value, label);
        if (amount.isNegative()) throw new InvalidDecimalError("negative");
        if (amount.greaterThan(MAX_MONEY)) throw new InvalidDecimalError("too large");
        return moneyToString(amount);
      } catch {
        context.addIssue({
          code: "custom",
          message: `Enter the ${label} as a plain amount, for example 1250 or 1250.50 (no commas).`,
        });
        return z.NEVER;
      }
    });
}

/** A conversion: more than zero, at most three decimal places. Output: "0.250". */
export function factorText(label: string) {
  return z
    .string()
    .trim()
    .transform((value, context) => {
      try {
        const factor = parseQuantity(value, label);
        if (!factor.greaterThan(0)) throw new InvalidDecimalError("not positive");
        if (factor.greaterThan(MAX_FACTOR)) throw new InvalidDecimalError("too large");
        return quantityToString(factor);
      } catch {
        context.addIssue({
          code: "custom",
          message: `Enter ${label} as a number greater than zero, for example 10 or 0.25 (up to 3 decimal places).`,
        });
        return z.NEVER;
      }
    });
}

/** A percentage from 0 to 100, at most two decimal places. Output: "7.50". */
export function percentText(label: string) {
  return z
    .string()
    .trim()
    .transform((value, context) => {
      try {
        const percent = parseMoney(value, label);
        if (percent.isNegative() || percent.greaterThan(100)) throw new InvalidDecimalError("out of range");
        return moneyToString(percent);
      } catch {
        context.addIssue({
          code: "custom",
          message: `Enter the ${label} as a percentage from 0 to 100, for example 0 or 7.5.`,
        });
        return z.NEVER;
      }
    });
}

/** Optional text: blank becomes "not set". */
export function optionalText(max: number, tooLong: string) {
  return z
    .string()
    .trim()
    .max(max, tooLong)
    .transform((value) => (value === "" ? null : value));
}

export const yesNo = z
  .union([z.boolean(), z.enum(["true", "false", "on", ""])])
  .transform((value) => value === true || value === "true" || value === "on");
