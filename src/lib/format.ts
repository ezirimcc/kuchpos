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
