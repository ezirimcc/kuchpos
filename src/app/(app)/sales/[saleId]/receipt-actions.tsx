"use client";

import { Printer, ShoppingCart } from "lucide-react";
import Link from "next/link";
import { useEffect, useRef, useState, useTransition } from "react";
import { flushSync } from "react-dom";
import { Alert } from "@/components/ui/alert";
import { Button, buttonVariants } from "@/components/ui/button";
import type { SaleDetail } from "@/server/business/sales";
import { recordReceiptPrintAction } from "../actions";
import { Receipt } from "../receipt";

/**
 * A receipt with its buttons, and the printing itself.
 *
 * Every print is first noted on the server, which says whether it is the original or a
 * reprint; a reprint is marked on the paper. Straight after a sale the receipt prints by
 * itself, once, if the business has chosen automatic printing in Settings (C63); either way
 * "New sale" has the keyboard focus so Enter starts the next sale.
 */
export function ReceiptWithActions({
  sale,
  justSold,
  canSell,
}: {
  sale: SaleDetail;
  /** True when the page was opened by completing this sale. */
  justSold: boolean;
  canSell: boolean;
}) {
  const alreadyPrinted = sale.printCount > 0;
  const [pending, startTransition] = useTransition();
  const [reprint, setReprint] = useState(alreadyPrinted);
  const [printed, setPrinted] = useState(alreadyPrinted);
  const [problem, setProblem] = useState<string | null>(null);
  const started = useRef(false);
  const newSale = useRef<HTMLAnchorElement>(null);

  function print() {
    if (pending) return;
    setProblem(null);
    startTransition(async () => {
      const result = await recordReceiptPrintAction(sale.id);
      if (result.status !== "success") {
        setProblem(result.status === "error" ? result.message : "The receipt could not be printed. Try again.");
        return;
      }
      // The mark must be on the page before the browser takes its picture of it.
      flushSync(() => {
        setReprint(result.reprint === true);
        setPrinted(true);
      });
      window.print();
    });
  }

  useEffect(() => {
    if (!justSold) return;
    newSale.current?.focus();
    // Straight after the sale: print once, without being asked — if the business has chosen that (C63).
    if (!sale.business.autoPrintReceipts || alreadyPrinted || started.current) return;
    started.current = true;
    print();
    // Runs once when the page opens; `print` is recreated on every draw.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="flex flex-wrap items-start gap-6">
      <Receipt sale={sale} reprint={reprint} />
      <div className="flex min-w-56 flex-col gap-3">
        {canSell && (
          <Link ref={newSale} href="/sell" className={buttonVariants({ size: "lg" })} data-testid="new-sale">
            <ShoppingCart className="size-4" aria-hidden /> New sale
          </Link>
        )}
        <Button type="button" size="lg" variant="outline" onClick={print} disabled={pending}>
          <Printer className="size-4" aria-hidden /> {printed ? "Print again" : "Print receipt"}
        </Button>
        {problem && <Alert variant="destructive">{problem}</Alert>}
        <p className="max-w-56 text-xs text-muted-foreground">
          {justSold && canSell ? "Press Enter for the next sale. " : ""}A receipt printed again is marked REPRINT, and the
          reprint is written in the activity log.
        </p>
      </div>
    </div>
  );
}
