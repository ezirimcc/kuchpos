"use client";

import { useState, useTransition } from "react";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { formatDateTime, nairaFromText } from "@/lib/format";
import type { TillCashRequestView } from "@/server/business/till";
import { requestTillCashAction, withdrawTillCashAction } from "./actions";

const STATUS: Record<TillCashRequestView["status"], string> = {
  WAITING: "Waiting for a manager",
  APPROVED: "Approved",
  REFUSED: "Refused",
  WITHDRAWN: "Taken back",
};

/**
 * Cash put into the open till, or taken out of it, during the day (C64): always with a note.
 * A cashier's request waits for a manager, admin or owner; theirs counts at once.
 */
export function TillCashForm({ sessionId, countsAtOnce, requests }: { sessionId: string; countsAtOnce: boolean; requests: TillCashRequestView[] }) {
  const [pending, startTransition] = useTransition();
  // The request's unique ID, made before anything is sent: pressing twice records it once.
  const [requestId, setRequestId] = useState(() => crypto.randomUUID());
  const [direction, setDirection] = useState<"IN" | "OUT">("OUT");
  const [amount, setAmount] = useState("");
  const [note, setNote] = useState("");
  const [message, setMessage] = useState<{ good: boolean; text: string } | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});

  function send(event: React.FormEvent) {
    event.preventDefault();
    if (pending) return;
    setMessage(null);
    setErrors({});
    startTransition(async () => {
      const result = await requestTillCashAction({ requestId, sessionId, direction, amount: amount.trim(), note });
      if (result.status === "success") {
        setRequestId(crypto.randomUUID());
        setAmount("");
        setNote("");
        setMessage({ good: true, text: result.waiting ? "Sent. It counts once a manager or admin has approved it." : "Recorded." });
      } else if (result.status === "error") {
        setMessage({ good: false, text: result.message });
        setErrors(result.fieldErrors);
      }
    });
  }

  function takeBack(id: string) {
    if (pending) return;
    startTransition(async () => {
      await withdrawTillCashAction(id);
    });
  }

  return (
    <div className="flex flex-col gap-4" data-testid="till-cash">
      <form onSubmit={send} className="flex max-w-2xl flex-col gap-3">
        <div>
          <h2 className="text-base font-semibold">Cash in / cash out</h2>
          <p className="mt-0.5 text-sm text-muted-foreground">
            For cash put into the drawer or taken out of it that is not a sale — more change, money sent to the bank, a small expense.{" "}
            {countsAtOnce ? "What you record here counts at once." : "It is sent to a manager or admin and counts once they approve it."}
          </p>
        </div>
        <div className="grid gap-3 sm:grid-cols-[10rem_12rem_1fr]">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="cash-direction">In or out</Label>
            <NativeSelect id="cash-direction" value={direction} onChange={(event) => setDirection(event.target.value === "IN" ? "IN" : "OUT")}>
              <option value="OUT">Cash out</option>
              <option value="IN">Cash in</option>
            </NativeSelect>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="cash-amount">Amount (₦)</Label>
            <Input
              id="cash-amount"
              value={amount}
              onChange={(event) => setAmount(event.target.value)}
              inputMode="decimal"
              autoComplete="off"
              className="text-right tabular-nums"
              aria-invalid={!!errors.amount}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="cash-note">What it is for</Label>
            <Input id="cash-note" value={note} onChange={(event) => setNote(event.target.value)} maxLength={300} autoComplete="off" aria-invalid={!!errors.note} />
          </div>
        </div>
        {(errors.amount || errors.note || errors.direction) && <p className="text-xs text-destructive">{errors.amount ?? errors.note ?? errors.direction}</p>}
        {message && (message.good ? <p className="text-sm font-medium text-emerald-700 dark:text-emerald-400">{message.text}</p> : <Alert variant="destructive">{message.text}</Alert>)}
        <div>
          <Button type="submit" variant="outline" disabled={pending}>
            {pending ? "Saving…" : countsAtOnce ? "Record" : "Send for approval"}
          </Button>
        </div>
      </form>

      {requests.length > 0 && (
        <ul className="flex flex-col text-sm">
          {requests.map((request) => (
            <li key={request.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t py-2" data-testid="till-cash-row">
              <span className="font-medium tabular-nums">
                {request.direction === "IN" ? "Cash in" : "Cash out"} {nairaFromText(request.amount)}
              </span>
              <span>{request.note}</span>
              <span className="text-muted-foreground">
                {request.requestedByName}, {formatDateTime(request.requestedAt)}
              </span>
              <Badge variant={request.status === "REFUSED" ? "destructive" : request.status === "APPROVED" ? "default" : "secondary"}>{STATUS[request.status]}</Badge>
              {request.decidedByName && request.status !== "WITHDRAWN" && request.decidedByName !== request.requestedByName && (
                <span className="text-muted-foreground">
                  by {request.decidedByName}
                  {request.decisionNote ? `: ${request.decisionNote}` : ""}
                </span>
              )}
              {request.canWithdraw && (
                <button type="button" className="ml-auto text-link underline-offset-4 hover:underline" onClick={() => takeBack(request.id)} disabled={pending}>
                  Take back
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
