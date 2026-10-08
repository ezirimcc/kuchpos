"use client";

import { useState, useTransition } from "react";
import { rememberTerminal, useRememberedTerminal } from "@/components/terminal-choice";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { nairaFromText } from "@/lib/format";
import type { RepaymentOptions } from "@/server/business/customers";
import { recordRepaymentAction } from "../actions";

/**
 * Records money received from a customer against their debt: part of it or all of it.
 * Cash goes into the open till of the checkout chosen; a transfer or POS payment does not.
 */
export function RepaymentForm({
  customerId,
  owed,
  options,
  unpaidSales,
}: {
  customerId: string;
  owed: string;
  options: RepaymentOptions;
  unpaidSales: { saleId: string; receiptNumber: string; outstanding: string }[];
}) {
  const [pending, startTransition] = useTransition();
  // Made up once per repayment, so pressing Save twice can never record it twice.
  const [requestId, setRequestId] = useState(() => crypto.randomUUID());
  const [amount, setAmount] = useState("");
  const [methodId, setMethodId] = useState(options.paymentMethods[0]?.id ?? "");
  const [reference, setReference] = useState("");
  const [saleId, setSaleId] = useState("");
  const [note, setNote] = useState("");
  const [chosenTerminal, setChosenTerminal] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});

  const remembered = useRememberedTerminal();
  const terminalId =
    [chosenTerminal, remembered].find((id) => id && options.terminals.some((terminal) => terminal.id === id)) ??
    (options.terminals.length === 1 ? options.terminals[0].id : "");
  const terminal = options.terminals.find((candidate) => candidate.id === terminalId);
  const isCash = options.paymentMethods.find((method) => method.id === methodId)?.kind === "CASH";

  function save(event: React.FormEvent) {
    event.preventDefault();
    if (pending) return;
    setMessage(null);
    setSaved(null);
    setErrors({});
    startTransition(async () => {
      const result = await recordRepaymentAction({
        requestId,
        customerId,
        amount: amount.trim(),
        methodId,
        reference: isCash ? "" : reference,
        terminalId: isCash ? terminalId : "",
        saleId,
        note,
      });
      if (result.status === "success") {
        // The page is drawn again by the server with the new balance and statement.
        setSaved(`Repayment of ${nairaFromText(/^\d+(\.\d{1,2})?$/.test(amount.trim()) ? amount.trim() : "0")} saved.`);
        setRequestId(crypto.randomUUID());
        setAmount("");
        setReference("");
        setSaleId("");
        setNote("");
      } else if (result.status === "error") {
        setMessage(result.message);
        setErrors(result.fieldErrors);
      }
    });
  }

  const problem = (name: string) => (errors[name] ? <p className="text-xs text-destructive">{errors[name]}</p> : null);

  return (
    <form onSubmit={save} className="flex flex-col gap-4" data-testid="repayment-form">
      <div>
        <h2 className="text-base font-semibold">Receive a repayment</h2>
        <p className="mt-0.5 text-sm text-muted-foreground">
          Part of the debt or all of it — never more than the {nairaFromText(owed)} owed. It pays off the oldest sales first.
        </p>
      </div>
      <div className="grid gap-x-4 gap-y-4 md:grid-cols-2">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="repayment-amount">Amount received (₦)</Label>
          <div className="flex gap-2">
            <Input
              id="repayment-amount"
              value={amount}
              onChange={(event) => setAmount(event.target.value)}
              inputMode="decimal"
              autoComplete="off"
              aria-invalid={!!errors.amount}
              className="text-right tabular-nums"
              required
            />
            <Button type="button" variant="outline" className="shrink-0" onClick={() => setAmount(owed)}>
              All of it
            </Button>
          </div>
          {problem("amount")}
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="repayment-method">Paid by</Label>
          <NativeSelect id="repayment-method" value={methodId} onChange={(event) => setMethodId(event.target.value)} aria-invalid={!!errors.methodId}>
            {options.paymentMethods.map((method) => (
              <option key={method.id} value={method.id}>
                {method.name}
              </option>
            ))}
          </NativeSelect>
          {problem("methodId")}
        </div>

        {isCash ? (
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="repayment-terminal">The cash goes into the till of</Label>
            <NativeSelect
              id="repayment-terminal"
              value={terminalId}
              onChange={(event) => {
                setChosenTerminal(event.target.value);
                rememberTerminal(event.target.value);
              }}
              aria-invalid={!!errors.terminalId}
              required
            >
              {terminalId === "" && <option value="">Choose a checkout…</option>}
              {options.terminals.map((candidate) => (
                <option key={candidate.id} value={candidate.id}>
                  {candidate.code} — {candidate.name}
                  {candidate.tillOpen ? "" : " (till closed)"}
                </option>
              ))}
            </NativeSelect>
            {problem("terminalId")}
            {!errors.terminalId && terminal && !terminal.tillOpen && (
              <p className="text-xs text-destructive">The till of {terminal.code} is closed. Open it first, or take the repayment another way.</p>
            )}
          </div>
        ) : (
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="repayment-reference">Reference (optional)</Label>
            <Input id="repayment-reference" value={reference} onChange={(event) => setReference(event.target.value)} autoComplete="off" maxLength={60} aria-invalid={!!errors.reference} />
            {problem("reference")}
          </div>
        )}

        {unpaidSales.length > 1 && (
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="repayment-sale">Pay off first</Label>
            <NativeSelect id="repayment-sale" value={saleId} onChange={(event) => setSaleId(event.target.value)} aria-invalid={!!errors.saleId}>
              <option value="">The oldest unpaid sale</option>
              {unpaidSales.map((sale) => (
                <option key={sale.saleId} value={sale.saleId}>
                  {sale.receiptNumber} — {nairaFromText(sale.outstanding)} left
                </option>
              ))}
            </NativeSelect>
            {problem("saleId")}
          </div>
        )}

        <div className="flex flex-col gap-1.5 md:col-span-2">
          <Label htmlFor="repayment-note">Note (optional)</Label>
          <Input id="repayment-note" value={note} onChange={(event) => setNote(event.target.value)} autoComplete="off" maxLength={300} />
          {problem("note")}
        </div>
      </div>
      {message && <Alert variant="destructive">{message}</Alert>}
      {saved && <Alert data-testid="repayment-saved">{saved}</Alert>}
      <div>
        <Button type="submit" size="lg" disabled={pending}>
          {pending ? "Saving…" : "Save repayment"}
        </Button>
      </div>
    </form>
  );
}
