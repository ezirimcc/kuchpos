"use client";

import { Calculator } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { type CashBreakdown, NAIRA_NOTES as NOTES } from "@/lib/cash-notes";
import { Decimal } from "@/lib/decimal";
import { formatNaira, moneyToString } from "@/lib/money";

const isCount = (text: string) => /^\d{1,7}$/.test(text.trim());
const isMoney = (text: string) => /^\d+(\.\d{1,2})?$/.test(text.trim());

/**
 * Helps count cash: how many of each note, plus any coins or loose amount. Each time a number
 * changes, the total and the count behind it are handed to the form through `onTotal`: the
 * total goes in the amount box, and the count is saved with it for the manager to see.
 */
export function CashCounter({
  idPrefix,
  onTotal,
}: {
  idPrefix: string;
  onTotal: (amount: string, breakdown: CashBreakdown) => void;
}) {
  const [open, setOpen] = useState(false);
  const [counts, setCounts] = useState<Record<string, string>>({});
  const [other, setOther] = useState("");

  function totalOf(nextCounts: Record<string, string>, nextOther: string): Decimal | null {
    let total = new Decimal(0);
    for (const note of NOTES) {
      const typed = (nextCounts[note] ?? "").trim();
      if (typed === "") continue;
      if (!isCount(typed)) return null;
      total = total.plus(new Decimal(note).times(typed));
    }
    if (nextOther.trim() !== "") {
      if (!isMoney(nextOther)) return null;
      total = total.plus(nextOther.trim());
    }
    return total;
  }

  function change(nextCounts: Record<string, string>, nextOther: string) {
    setCounts(nextCounts);
    setOther(nextOther);
    const total = totalOf(nextCounts, nextOther);
    if (total) onTotal(moneyToString(total), { notes: nextCounts, other: nextOther });
  }

  const total = totalOf(counts, other);

  if (!open) {
    return (
      <Button type="button" variant="outline" size="sm" className="w-fit" onClick={() => setOpen(true)}>
        <Calculator className="size-4" aria-hidden /> Count by notes
      </Button>
    );
  }

  return (
    <div className="flex flex-col gap-2 rounded-2xl border p-3" data-testid={`${idPrefix}-cash-counter`}>
      <p className="text-sm font-medium">How many of each note?</p>
      <div className="grid grid-cols-[auto_1fr_auto] items-center gap-x-3 gap-y-1.5 text-sm">
        {NOTES.map((note) => {
          const typed = (counts[note] ?? "").trim();
          const bad = typed !== "" && !isCount(typed);
          return (
            <div key={note} className="contents">
              <label htmlFor={`${idPrefix}-note-${note}`} className="tabular-nums">
                ₦{note} ×
              </label>
              <Input
                id={`${idPrefix}-note-${note}`}
                value={counts[note] ?? ""}
                onChange={(event) => change({ ...counts, [note]: event.target.value }, other)}
                inputMode="numeric"
                autoComplete="off"
                aria-invalid={bad}
                className="h-8 text-right tabular-nums"
              />
              <span className="min-w-24 text-right text-muted-foreground tabular-nums">
                {typed !== "" && !bad ? formatNaira(new Decimal(note).times(typed)) : bad ? "whole number" : "—"}
              </span>
            </div>
          );
        })}
        <div className="contents">
          <label htmlFor={`${idPrefix}-other`}>Coins / other ₦</label>
          <Input
            id={`${idPrefix}-other`}
            value={other}
            onChange={(event) => change(counts, event.target.value)}
            inputMode="decimal"
            autoComplete="off"
            aria-invalid={other.trim() !== "" && !isMoney(other)}
            className="h-8 text-right tabular-nums"
          />
          <span className="min-w-24 text-right text-muted-foreground tabular-nums">
            {other.trim() !== "" && isMoney(other) ? formatNaira(new Decimal(other.trim())) : "—"}
          </span>
        </div>
      </div>
      <p className="flex items-baseline justify-between border-t pt-2 text-sm">
        <span className="text-muted-foreground">Total counted</span>
        <span className="text-lg font-semibold tabular-nums" data-testid={`${idPrefix}-cash-counter-total`}>
          {total ? formatNaira(total) : "Check the numbers above"}
        </span>
      </p>
      <p className="text-xs text-muted-foreground">
        The total is put in the amount box for you, and this count is saved with it. If you then change the amount by
        hand, only the amount is saved.
      </p>
    </div>
  );
}
