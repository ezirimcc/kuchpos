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
