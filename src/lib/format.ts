import { Decimal } from "./decimal";
import { formatNaira } from "./money";

const SHOP_TIME_ZONE = "Africa/Lagos";

const dateTimeFormat = new Intl.DateTimeFormat("en-NG", {
  timeZone: SHOP_TIME_ZONE,
  day: "numeric",
  month: "short",
  year: "numeric",
  hour: "numeric",
  minute: "2-digit",
  hour12: true,
});

/** Shows a stored (universal) time as Nigerian local time, e.g. "2 Oct 2026, 7:15 am". */
export function formatDateTime(date: Date): string {
  return dateTimeFormat.format(date);
}


/** "1250.50" → "₦1,250.50". */
export function nairaFromText(amount: string): string {
  return formatNaira(new Decimal(amount));
}

/** "10.000" → "10", "0.250" → "0.25". */
export function plainNumber(value: string): string {
  return new Decimal(value).toString();
}

/** Nigeria keeps the same clock all year: one hour ahead of universal time. */
const SHOP_UTC_OFFSET = "+01:00";

/** The first moment of a shop day given as "YYYY-MM-DD", or null if that is not a real date. */
export function shopDayStart(day: string): Date | null {
  const moment = new Date(`${day}T00:00:00.000${SHOP_UTC_OFFSET}`);
  return Number.isNaN(moment.getTime()) ? null : moment;
}

/** The first moment of the day AFTER the given shop day (so "before this" covers the whole day). */
export function shopDayEnd(day: string): Date | null {
  const start = shopDayStart(day);
  return start ? new Date(start.getTime() + 24 * 60 * 60 * 1000) : null;
}

/** Today's date in the shop's own time, as "YYYY-MM-DD". */
export function shopToday(now: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: SHOP_TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

/** "Good morning", "Good afternoon" or "Good evening", by the shop's clock. */
export function shopGreeting(now: Date = new Date()): string {
  const hour = Number.parseInt(
    new Intl.DateTimeFormat("en-GB", { timeZone: SHOP_TIME_ZONE, hour: "2-digit", hourCycle: "h23" }).format(now),
    10,
  );
  if (hour < 12) return "Good morning";
  if (hour < 17) return "Good afternoon";
  return "Good evening";
}

const dateFormat = new Intl.DateTimeFormat("en-NG", { timeZone: SHOP_TIME_ZONE, day: "numeric", month: "long", year: "numeric" });

/** A stored time as a Nigerian date, e.g. "3 October 2026". */
export function formatDate(date: Date): string {
  return dateFormat.format(date);
}

/** A calendar day "YYYY-MM-DD" as the value stored in a date-only database column, or null if not a real date. */
export function dayToDate(day: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
  const date = new Date(`${day}T00:00:00.000Z`);
  return Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== day ? null : date;
}

/** The reverse: a date-only database value back to "YYYY-MM-DD". */
export function dateToDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

const dayFormat = new Intl.DateTimeFormat("en-NG", { timeZone: "UTC", day: "numeric", month: "short", year: "numeric" });

/** A calendar day "YYYY-MM-DD" for reading, e.g. "3 Oct 2026". */
export function formatDay(day: string): string {
  const date = dayToDate(day);
  return date ? dayFormat.format(date) : day;
}

/** A day the given number of months after another, as "YYYY-MM-DD" (the end of a shorter month is respected). */
export function addMonths(day: string, months: number): string {
  const [year, month, dayOfMonth] = day.split("-").map((part) => Number.parseInt(part, 10));
  const target = new Date(Date.UTC(year, month - 1 + months, 1));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(dayOfMonth, lastDay));
  return target.toISOString().slice(0, 10);
}

/** Delivery numbers are shown as GR-000012. */
export function receiptNumber(number: number): string {
  return `GR-${String(number).padStart(6, "0")}`;
}

/** Sales receipt numbers start with the terminal's code: T1-000012. */
export function saleReceiptNumber(terminalCode: string, sequence: number): string {
  return `${terminalCode}-${String(sequence).padStart(6, "0")}`;
}

/** The number of a receipt made during an internet outage: the terminal's own offline series, e.g. "T1-F000007". */
export function offlineReceiptNumber(terminalCode: string, number: number): string {
  return `${terminalCode}-F${String(number).padStart(6, "0")}`;
}

/** RT-000012: the number on a return slip. */
export function returnNumber(number: number): string {
  return `RT-${String(number).padStart(6, "0")}`;
}

/** Repayment numbers are shown as RP-000012. */
export function repaymentNumber(number: number): string {
  return `RP-${String(number).padStart(6, "0")}`;
}

/** Till session numbers are shown as TS-000012. */
export function tillSessionNumber(number: number): string {
  return `TS-${String(number).padStart(6, "0")}`;
}

/** Transfer numbers are shown as TR-000012. */
export function transferNumber(number: number): string {
  return `TR-${String(number).padStart(6, "0")}`;
}

/** A change in quantity for reading: "+5", "−5" (with a real minus sign) or "0". */
export function signedNumber(value: string): string {
  const plain = plainNumber(value.replace(/^-/, ""));
  if (plain === "0") return "0";
  return value.startsWith("-") ? `−${plain}` : `+${plain}`;
}

/** Stock count numbers are shown as SC-000012, adjustment numbers as AD-000012. */
export function countNumber(number: number): string {
  return `SC-${String(number).padStart(6, "0")}`;
}

export function adjustmentNumber(number: number): string {
  return `AD-${String(number).padStart(6, "0")}`;
}

/**
 * A quantity in base units, also broken into the product's larger units for reading:
 * 215 singles with pack = 10 and carton = 100 → "2 carton + 1 pack + 5 single".
 */
export function breakIntoUnits(
  baseQuantity: string,
  baseUnitName: string,
  units: { name: string; factor: string }[],
): string {
  let remaining = new Decimal(baseQuantity);
  const parts: string[] = [];
  const larger = units
    .map((unit) => ({ name: unit.name, factor: new Decimal(unit.factor) }))
    .filter((unit) => unit.factor.greaterThan(1))
    .sort((a, b) => b.factor.comparedTo(a.factor));
  for (const unit of larger) {
    const count = remaining.dividedToIntegerBy(unit.factor);
    if (count.greaterThan(0)) {
      parts.push(`${count.toString()} ${unit.name}`);
      remaining = remaining.minus(count.times(unit.factor));
    }
  }
  if (remaining.greaterThan(0) || parts.length === 0) parts.push(`${remaining.toString()} ${baseUnitName}`);
  return parts.join(" + ");
}
