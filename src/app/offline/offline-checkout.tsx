"use client";

import { CloudOff, Printer, Wifi } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { type CartHandover, Checkout, HANDOVER_KEY, type SaleToSave } from "@/app/(app)/sell/checkout";
import { Receipt } from "@/app/(app)/sales/receipt";
import { useRememberedTerminal } from "@/components/terminal-choice";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Decimal } from "@/lib/decimal";
import { formatDateTime, nairaFromText, offlineReceiptNumber } from "@/lib/format";
import { lineTotal, moneyToString, sumMoney, taxIncludedIn } from "@/lib/money";
import { addToQueue, lastKit, noteTillOpen, type OfflineReceipt, type QueueItem, type StoredKit, takeOfflineNumber, tillKnownOpen } from "@/lib/offline/store";
import { type SendResult, sendWaiting } from "@/lib/offline/sync";
import { useUnsentQueue } from "@/lib/offline/use-queue";
import type { SaleDetail } from "@/server/business/sales";

/** How often this page looks whether the server can be reached again, in milliseconds. */
const LOOK_EVERY_MS = 15_000;

const isMoney = (text: string) => /^\d+(\.\d{1,2})?$/.test(text.trim());

function readHandover(): CartHandover | null {
  try {
    const kept = window.sessionStorage.getItem(HANDOVER_KEY);
    window.sessionStorage.removeItem(HANDOVER_KEY);
    const parsed: unknown = kept ? JSON.parse(kept) : null;
    if (parsed && typeof parsed === "object" && typeof (parsed as CartHandover).requestId === "string" && Array.isArray((parsed as CartHandover).lines)) {
      return parsed as CartHandover;
    }
  } catch {
    // Nothing to carry over.
  }
  return null;
}

/** What the receipt of a sale made here shows, worked out from this computer's copy of the prices. */
function receiptFor(kit: StoredKit, sale: SaleToSave, receiptNumber: string): OfflineReceipt {
  const { catalogue } = kit;
  const rate = new Decimal(catalogue.taxRatePercent);
  const terminal = kit.terminals.find((candidate) => candidate.id === sale.terminalId);
  const customer = catalogue.customers.find((candidate) => candidate.id === sale.customerId);
  const lines = sale.lines.map((line, index) => {
    const product = catalogue.products.find((candidate) => candidate.id === line.productId)!;
    const unit = product.units.find((candidate) => candidate.id === line.unitId)!;
    const amount = lineTotal(new Decimal(line.quantity), new Decimal(line.unitPrice));
    return {
      lineNumber: index + 1,
      productName: product.name,
      unitName: unit.name,
      quantity: line.quantity,
      baseQuantity: new Decimal(line.quantity).times(unit.factor).toFixed(3),
      unitPrice: line.unitPrice,
      lineTotal: moneyToString(amount),
      taxAmount: moneyToString(product.taxable ? taxIncludedIn(amount, rate) : new Decimal(0)),
      locationName: line.fromStoreroom ? "Storeroom" : "Shelf",
    };
  });
  const payments = sale.payments.map((payment) => {
    const method = catalogue.paymentMethods.find((candidate) => candidate.id === payment.methodId)!;
    const cash = method.kind === "CASH";
    const tendered = cash ? (payment.tendered === "" ? payment.amount : moneyToString(new Decimal(payment.tendered))) : null;
    return {
      methodName: method.name,
      kind: method.kind,
      amount: payment.amount,
      tendered,
      change: tendered === null ? null : moneyToString(new Decimal(tendered).minus(payment.amount)),
      reference: payment.reference || null,
    };
  });
  return {
    id: sale.requestId,
    receiptNumber,
    createdAt: sale.deviceTime,
    cashierName: kit.cashier.name,
    terminalCode: terminal?.code ?? "",
    paperWidth: terminal?.paperWidth ?? "MM80",
    total: sale.expectedTotal,
    taxRatePercent: catalogue.taxRatePercent,
    taxTotal: moneyToString(sumMoney(lines.map((line) => new Decimal(line.taxAmount)))),
    costTotal: null,
    payments,
    change: moneyToString(sumMoney(payments.map((payment) => new Decimal(payment.change ?? "0")))),
    subtotal: sale.expectedTotal,
    discountAmount: "0.00",
    discountPercent: null,
    discountReason: null,
    discountApprovedBy: null,
    offline: null,
    customer: customer ? { id: customer.id, name: customer.name, phone: customer.phone } : null,
    creditAmount: "0.00",
    owedAfter: null,
    cancellation: null,
    canCancel: false,
    printCount: 0,
    business: kit.business,
    lines,
  };
}

const asSale = (receipt: OfflineReceipt): SaleDetail => ({ ...receipt, createdAt: new Date(receipt.createdAt) });

export function OfflineCheckout() {
  // undefined while this computer's kept data is being read; null when there is none.
  const [kit, setKit] = useState<StoredKit | null | undefined>(undefined);
  const [start, setStart] = useState<CartHandover | null>(null);
  const [tills, setTills] = useState<Record<string, boolean>>({});
  const [shown, setShown] = useState<{ receipt: OfflineReceipt; fresh: boolean } | null>(null);
  const [reachable, setReachable] = useState(false);
  const [sending, setSending] = useState<SendResult | "busy" | null>(null);
  // The time, as last looked at (a page may not read the clock while it is being drawn).
  const [clock, setClock] = useState(() => Date.now());
  const [float, setFloat] = useState("");
  const [floatProblem, setFloatProblem] = useState<string | null>(null);
  const unsent = useUnsentQueue();
  const remembered = useRememberedTerminal();

  useEffect(() => {
    let gone = false;
    void (async () => {
      const kept = await lastKit().catch(() => null);
      if (gone) return;
      if (kept) {
        const open: Record<string, boolean> = {};
        for (const terminal of kept.terminals) open[terminal.id] = await tillKnownOpen(terminal.id);
        if (gone) return;
        setTills(open);
        setStart(readHandover());
      }
      setKit(kept);
      document.documentElement.dataset.ready = "true";
    })();
    return () => {
      gone = true;
    };
  }, []);

  const send = useCallback(async () => {
    setSending("busy");
    setSending(await sendWaiting());
  }, []);

  // Looks, every so often, whether the server can be reached again; when it can, what is
  // waiting is sent straight away.
  useEffect(() => {
    let gone = false;
    async function look() {
      let ok = false;
      try {
        ok = (await fetch("/api/health", { cache: "no-store" })).ok;
      } catch {
        ok = false;
      }
      if (gone) return;
      setClock(Date.now());
      setReachable((before) => {
        if (ok && !before) void send();
        return ok;
      });
    }
    void look();
    const timer = window.setInterval(look, LOOK_EVERY_MS);
    return () => {
      gone = true;
      window.clearInterval(timer);
    };
  }, [send]);

  const waiting = (unsent ?? []).filter((item) => item.status === "waiting");
  const refused = (unsent ?? []).filter((item) => item.status === "refused");

  const terminalId = kit
    ? ([remembered].find((id) => id && kit.terminals.some((terminal) => terminal.id === id)) ?? (kit.terminals.length === 1 ? kit.terminals[0].id : ""))
    : "";
  const terminal = kit?.terminals.find((candidate) => candidate.id === terminalId);

  // The checkout is given this computer's copy of the catalogue, with what cannot be done offline switched off.
  const catalogue = useMemo(
    () =>
      kit
        ? {
            ...kit.catalogue,
            terminals: kit.catalogue.terminals.map((entry) => ({ ...entry, tillOpen: tills[entry.id] === true })),
            canSellOnCredit: false,
            canAllowOverLimit: false,
            canDiscount: false,
            canApproveDiscount: false,
          }
        : null,
    [kit, tills],
  );

  if (kit === undefined) return <p className="p-10 text-center text-sm text-muted-foreground">Opening the checkout…</p>;
  if (!kit || !catalogue) {
    return (
      <Card className="mx-auto max-w-xl">
        <CardContent className="flex flex-col gap-3">
          <p className="flex items-center gap-2 text-lg font-semibold">
            <CloudOff className="size-5" aria-hidden /> No internet, and this computer is not ready to sell without it
          </p>
          <p className="text-sm text-muted-foreground" data-testid="offline-not-ready">
            Selling without internet works on a computer where a cashier has opened the Sell screen while the internet was
            working. That has not happened here, or the cashier has since signed out. Connect to the internet, sign in and
            open Sell once; after that this computer can carry on through an outage.
          </p>
          <a href="/sign-in" className="w-fit text-sm text-link underline-offset-4 hover:underline">
            Try to sign in
          </a>
        </CardContent>
      </Card>
    );
  }

  const until = new Date(kit.passExpiresAt);
  const tooLate = clock > until.getTime();

  async function save(sale: SaleToSave): Promise<string | null> {
    if (!kit) return "This computer is not ready to sell without internet.";
    if (Date.now() > new Date(kit.passExpiresAt).getTime()) return "The time for selling without internet has run out. Connect to the internet and sign in.";
    const code = kit.terminals.find((candidate) => candidate.id === sale.terminalId)?.code;
    if (!code) return "Choose the checkout terminal.";
    try {
      const receiptNumber = offlineReceiptNumber(code, await takeOfflineNumber(sale.terminalId));
      const receipt = receiptFor(kit, sale, receiptNumber);
      await addToQueue({
        id: sale.requestId,
        kind: "sale",
        payload: { ...sale, pass: kit.pass, receiptNumber },
        madeAt: sale.deviceTime,
        cashierName: kit.cashier.name,
        terminalId: sale.terminalId,
        receipt,
        status: "waiting",
      });
      setShown({ receipt, fresh: true });
      if (reachable) void send();
      return null;
    } catch {
      return "The sale could not be kept on this computer, so it was NOT made. Check that the browser is not in a private window, then try again.";
    }
  }

  async function openTill() {
    if (!kit || !terminal) return;
    if (!isMoney(float)) {
      setFloatProblem("Enter the cash in the drawer as a plain amount, for example 5000 (0 if there is none).");
      return;
    }
    setFloatProblem(null);
    const now = new Date().toISOString();
    await addToQueue({
      id: crypto.randomUUID(),
      kind: "till",
      payload: { terminalId: terminal.id, openingFloat: float.trim(), pass: kit.pass, deviceTime: now },
      madeAt: now,
      cashierName: kit.cashier.name,
      terminalId: terminal.id,
      status: "waiting",
    });
    await noteTillOpen(terminal.id, true);
    setTills((current) => ({ ...current, [terminal.id]: true }));
    setFloat("");
  }

  const describe = (item: QueueItem) =>
    item.kind === "till" ? "Opening of the till" : `Receipt ${item.receipt?.receiptNumber ?? ""} — ${nairaFromText(item.receipt?.total ?? "0.00")}`;

  return (
    <div className="flex flex-col gap-4">
      <div
        className={`flex flex-wrap items-center gap-x-4 gap-y-2 rounded-3xl px-5 py-4 text-sm font-medium ${reachable ? "bg-emerald-600 text-white" : "bg-amber-400 text-black"}`}
        data-testid="offline-bar"
      >
        <span className="flex items-center gap-2 text-base font-semibold">
          {reachable ? <Wifi className="size-5" aria-hidden /> : <CloudOff className="size-5" aria-hidden />}
          {reachable ? "The internet is back" : "No internet — selling continues on this computer"}
        </span>
        <span data-testid="offline-who">
          {kit.cashier.name} · {kit.business.name} · until {formatDateTime(until)}
        </span>
        <span data-testid="offline-waiting">
          {waiting.length === 0 ? "Nothing waiting to send" : waiting.length === 1 ? "1 waiting to send" : `${waiting.length} waiting to send`}
        </span>
        {reachable && (
          <span className="ml-auto flex flex-wrap items-center gap-2">
            {waiting.length > 0 && (
              <Button type="button" size="sm" variant="secondary" onClick={send} disabled={sending === "busy"} data-testid="send-now">
                {sending === "busy" ? "Sending…" : "Send now"}
              </Button>
            )}
            <a href="/sell" className="rounded-full bg-white px-4 py-2 text-sm font-semibold text-black" data-testid="back-online">
              Go back to normal selling
            </a>
          </span>
        )}
      </div>

      {sending && sending !== "busy" && sending.stopped === "signed-out" && (
        <Alert data-testid="sign-in-to-send">
          The internet is back, but nobody is signed in on this computer, so what is waiting cannot be sent yet.{" "}
          <a href="/sign-in" className="font-medium underline underline-offset-4">
            Sign in
          </a>{" "}
          and it is sent by itself. Nothing is lost meanwhile.
        </Alert>
      )}
      {sending && sending !== "busy" && sending.stopped === "not-allowed" && (
        <Alert variant="destructive">The person signed in on this computer may not sell, so what is waiting cannot be sent. A cashier, manager or admin must sign in.</Alert>
      )}
      {sending && sending !== "busy" && sending.stopped === "trouble" && (
        <Alert variant="destructive">
          Something is still waiting and could not be sent just now. If the till of this checkout was closed from another computer, open it
          again; otherwise it will be tried again shortly.
        </Alert>
      )}

      {refused.length > 0 && (
        <Alert variant="destructive" data-testid="offline-refused">
          <p className="font-semibold">The server did not accept {refused.length === 1 ? "one thing" : `${refused.length} things`} done without internet. Show this to a manager.</p>
          <ul className="mt-1 list-disc pl-5">
            {refused.map((item) => (
              <li key={item.id}>
                {describe(item)} ({formatDateTime(new Date(item.madeAt))}): {item.message}
              </li>
            ))}
          </ul>
        </Alert>
      )}

      {shown ? (
        <Card className="mx-auto w-full max-w-xl" data-testid="offline-receipt">
          <CardContent className="flex flex-col items-center gap-4">
            {shown.fresh && (
              <p className="text-center text-sm font-medium" data-testid="offline-sold">
                Sold. The sale is kept on this computer and will be sent when the internet returns.
              </p>
            )}
            <Receipt sale={asSale(shown.receipt)} reprint={false} />
            <div className="flex flex-wrap justify-center gap-2 print:hidden">
              <Button type="button" onClick={() => window.print()} data-testid="offline-print">
                <Printer className="size-4" aria-hidden /> Print receipt
              </Button>
              <Button type="button" variant="outline" onClick={() => setShown(null)} autoFocus data-testid="offline-next">
                Next sale
              </Button>
            </div>
          </CardContent>
        </Card>
      ) : tooLate ? (
        <Alert variant="destructive" data-testid="offline-too-late">
          {kit.cashier.name} could sell without internet until {formatDateTime(until)}. That time has passed. Connect this computer to the
          internet and sign in; selling then carries on, and what is waiting is sent.
        </Alert>
      ) : (
        <>
          {terminal && tills[terminal.id] !== true && (
            <Card data-testid="offline-open-till">
              <CardContent className="flex flex-col gap-3">
                <p className="font-semibold">The till of {terminal.code} is not open</p>
                <p className="text-sm text-muted-foreground">
                  Count the cash put in the drawer for change and open the till here. It is sent to the server with the sales when the
                  internet returns.
                </p>
                <div className="flex flex-wrap items-end gap-3">
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="offline-float">Cash in the drawer now (₦)</Label>
                    <Input
                      id="offline-float"
                      value={float}
                      onChange={(event) => setFloat(event.target.value)}
                      inputMode="decimal"
                      autoComplete="off"
                      className="w-48 text-right tabular-nums"
                      aria-invalid={!!floatProblem}
                    />
                  </div>
                  <Button type="button" onClick={openTill}>
                    Open the till
                  </Button>
                </div>
                {floatProblem && <p className="text-xs text-destructive">{floatProblem}</p>}
              </CardContent>
            </Card>
          )}
          <Checkout catalogue={catalogue} cashierId={kit.cashier.userId} offline={{ save }} start={start} />
          <p className="px-2 text-xs text-muted-foreground">
            Without internet: ordinary sales only, at the prices this computer last received ({formatDateTime(new Date(kit.takenAt))}). Discounts,
            credit, new customers and closing the till wait until the internet is back. Stock figures shown may be out of date.
          </p>
        </>
      )}

      {waiting.length > 0 && (
        <Card data-testid="offline-queue">
          <CardContent className="flex flex-col gap-1">
            <p className="text-sm font-semibold">Waiting to be sent</p>
            {waiting.map((item) => (
              <div key={item.id} className="flex flex-wrap items-center gap-3 border-t py-2 text-sm first:border-t-0">
                <span className="tabular-nums">{describe(item)}</span>
                <span className="text-muted-foreground">
                  {formatDateTime(new Date(item.madeAt))} · {item.cashierName}
                </span>
                {item.receipt && (
                  <button
                    type="button"
                    className="ml-auto text-link underline-offset-4 hover:underline"
                    onClick={() => setShown({ receipt: item.receipt!, fresh: false })}
                  >
                    Show receipt
                  </button>
                )}
              </div>
            ))}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
