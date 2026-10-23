"use client";

import { PencilLine } from "lucide-react";
import { useState, useTransition } from "react";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { nairaFromText } from "@/lib/format";
import type { PaymentKindValue } from "@/lib/payment-kinds";
import { correctPaymentAction } from "../actions";

type Payment = { id: string; methodName: string; amount: string };
type Method = { id: string; name: string; kind: PaymentKindValue };

/**
 * For an admin or manager (C81): the cashier recorded the wrong way of paying. Kept closed
 * behind a button. The payment itself stays on record; the correction is kept beside it and
 * written to the activity log with the reason.
 */
export function CorrectPaymentForm({ payments, methods }: { payments: Payment[]; methods: Method[] }) {
  const [pending, startTransition] = useTransition();
  const [open, setOpen] = useState(false);
  // Made once each time the form is opened, so pressing the button twice corrects only once.
  const [requestId, setRequestId] = useState("");
  const [paymentId, setPaymentId] = useState(payments[0]?.id ?? "");
  const [methodId, setMethodId] = useState("");
  const [reference, setReference] = useState("");
  const [reason, setReason] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});

  const payment = payments.find((entry) => entry.id === paymentId);
  const method = methods.find((entry) => entry.id === methodId);

  function start() {
    setRequestId(crypto.randomUUID());
    setOpen(true);
  }

  function save(event: React.FormEvent) {
    event.preventDefault();
    if (pending) return;
    setMessage(null);
    setErrors({});
    startTransition(async () => {
      // On success the page is drawn again by the server with the corrected way of paying.
      const result = await correctPaymentAction({ requestId, paymentId, methodId, reference, reason });
      if (result.status === "error") {
        setMessage(result.message);
        setErrors(result.fieldErrors);
      } else {
        setOpen(false);
        setMethodId("");
        setReference("");
        setReason("");
      }
    });
  }

  if (!open) {
    return (
      <div>
        <Button type="button" variant="outline" onClick={start}>
          <PencilLine className="size-4" aria-hidden /> Correct how it was paid
        </Button>
      </div>
    );
  }

  const problem = (name: string) => (errors[name] ? <p className="text-xs text-destructive">{errors[name]}</p> : null);

  return (
    <Card>
      <CardContent>
        <form onSubmit={save} className="flex max-w-xl flex-col gap-4" data-testid="correct-payment-form">
          <div>
            <h2 className="text-base font-semibold">Correct how it was paid</h2>
            <p className="mt-0.5 text-sm text-muted-foreground">
              For when the wrong way of paying was chosen at the checkout. The amount stays the same; the till, the day&apos;s collections and the
              receipt follow the correction. What was entered stays on record, and the correction is written to the activity log.
            </p>
          </div>
          {payments.length > 1 && (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="correct-payment">Which payment?</Label>
              <NativeSelect id="correct-payment" value={paymentId} onChange={(event) => setPaymentId(event.target.value)}>
                {payments.map((entry) => (
                  <option key={entry.id} value={entry.id}>
                    {nairaFromText(entry.amount)} entered as {entry.methodName}
                  </option>
                ))}
              </NativeSelect>
            </div>
          )}
          {payment && (
            <p className="text-sm">
              {nairaFromText(payment.amount)} is recorded as <span className="font-semibold">{payment.methodName}</span>.
            </p>
          )}
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="correct-method">How was it really paid?</Label>
            <NativeSelect id="correct-method" value={methodId} onChange={(event) => setMethodId(event.target.value)} aria-invalid={!!errors.methodId} required>
              <option value="">Choose…</option>
              {methods
                .filter((entry) => entry.name !== payment?.methodName)
                .map((entry) => (
                  <option key={entry.id} value={entry.id}>
                    {entry.name}
                  </option>
                ))}
            </NativeSelect>
            {problem("methodId")}
          </div>
          {method && method.kind !== "CASH" && (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="correct-reference">Reference (optional)</Label>
              <Input id="correct-reference" value={reference} onChange={(event) => setReference(event.target.value)} maxLength={60} autoComplete="off" />
              {problem("reference")}
            </div>
          )}
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="correct-reason">Why is it being corrected?</Label>
            <Input
              id="correct-reason"
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              aria-invalid={!!errors.reason}
              placeholder="For example: the customer paid by transfer, Cash was chosen by mistake"
              maxLength={300}
              autoComplete="off"
              required
            />
            {problem("reason")}
          </div>
          {message && <Alert variant="destructive">{message}</Alert>}
          <div className="flex flex-wrap gap-3">
            <Button type="submit" disabled={pending}>
              {pending ? "Saving…" : "Save the correction"}
            </Button>
            <Button type="button" variant="outline" disabled={pending} onClick={() => setOpen(false)}>
              Close
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
