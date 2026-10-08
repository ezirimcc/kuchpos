import { Decimal } from "./decimal";
import { formatNaira } from "./money";

/** Naira notes, largest first (SPEC C53). */
export const NAIRA_NOTES = ["1000", "500", "200", "100", "50", "20", "10", "5"] as const;

export type NairaNote = (typeof NAIRA_NOTES)[number];

/**
 * How an amount of cash was counted: how many of each note, plus coins or any loose amount.
 * Counts are whole numbers as text; `other` is a Naira amount as text ("" when none).
 */
export type CashBreakdown = { notes: Partial<Record<NairaNote, string>>; other: string };

const COUNT = /^\d{1,7}$/;
const MONEY = /^\d+(\.\d{1,2})?$/;

/** The total of a breakdown, or null if any part of it is not a proper number. */
export function breakdownTotal(breakdown: CashBreakdown): Decimal | null {
  let total = new Decimal(0);
  for (const note of NAIRA_NOTES) {
    const typed = (breakdown.notes[note] ?? "").trim();
    if (typed === "") continue;
    if (!COUNT.test(typed)) return null;
    total = total.plus(new Decimal(note).times(typed));
  }
  const other = breakdown.other.trim();
  if (other !== "") {
    if (!MONEY.test(other)) return null;
    total = total.plus(other);
  }
  return total;
}

/** The form in which a breakdown is stored: only the notes that were counted, and no stray spaces. */
export function storeBreakdown(breakdown: CashBreakdown): string {
  const notes: Partial<Record<NairaNote, string>> = {};
  for (const note of NAIRA_NOTES) {
    const typed = (breakdown.notes[note] ?? "").trim();
    if (typed !== "" && new Decimal(typed).greaterThan(0)) notes[note] = new Decimal(typed).toFixed(0);
  }
  const other = breakdown.other.trim();
  return JSON.stringify({ notes, other: other !== "" && new Decimal(other).greaterThan(0) ? new Decimal(other).toFixed(2) : "" });
}

/** A stored breakdown as lines for reading: "60 × ₦1,000", …, "Coins / other ₦20.00". Empty if there is none. */
export function describeBreakdown(stored: string | null): string[] {
  if (!stored) return [];
  try {
    const breakdown = JSON.parse(stored) as CashBreakdown;
    const lines = NAIRA_NOTES.filter((note) => breakdown.notes?.[note]).map(
      (note) => `${breakdown.notes[note]} × ${formatNaira(new Decimal(note)).replace(".00", "")}`,
    );
    if (breakdown.other) lines.push(`Coins / other ${formatNaira(new Decimal(breakdown.other))}`);
    return lines;
  } catch {
    return [];
  }
}
