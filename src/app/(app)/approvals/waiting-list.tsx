"use client";

import { useEffect, useState, useTransition } from "react";
import { APPROVALS_POLL_MS } from "@/components/approvals-waiting";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { nairaFromText, plainNumber } from "@/lib/format";
import type { WaitingApproval } from "@/server/business/approvals";
import { decideApprovalRequestAction } from "../sales/actions";

type Waiting = Omit<WaitingApproval, "requestedAt" | "expiresAt"> & { requestedAt: string; expiresAt: string };

const timeOf = (iso: string) => new Date(iso).toLocaleTimeString("en-NG", { hour: "2-digit", minute: "2-digit", timeZone: "Africa/Lagos" });

/** The requests waiting for this person's answer. The list refreshes itself every few seconds. */
export function WaitingList({ start }: { start: Waiting[] }) {
  const [requests, setRequests] = useState(start);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [message, setMessage] = useState<{ good: boolean; text: string } | null>(null);
  const [pending, startTransition] = useTransition();

  useEffect(() => {
    let stopped = false;
    async function look() {
      try {
        const response = await fetch("/api/approvals/waiting", { cache: "no-store" });
        if (response.status === 401 || response.status === 403) stopped = true;
        if (!response.ok || stopped) return;
        const body = (await response.json()) as { requests: Waiting[] };
        if (!stopped) setRequests(body.requests);
      } catch {
        // No connection just now; try again next time.
      }
    }
    const timer = window.setInterval(() => {
      if (stopped) window.clearInterval(timer);
      else void look();
    }, APPROVALS_POLL_MS);
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, []);

  function decide(request: Waiting, approve: boolean) {
    if (pending) return;
    setMessage(null);
    startTransition(async () => {
      const result = await decideApprovalRequestAction({ requestId: request.id, approve, note: notes[request.id] ?? "" });
      if (result.status === "error") {
        setMessage({ good: false, text: result.fieldErrors.note ?? result.message });
      } else {
        setMessage({ good: true, text: `${approve ? "Approved" : "Refused"}: ${request.requestedByName}'s request. Their screen will show it in a few seconds.` });
      }
      // Answered, or no longer there to answer: either way it leaves the list.
      if (result.status !== "error" || !result.fieldErrors.note) setRequests((current) => current.filter((entry) => entry.id !== request.id));
    });
  }

  return (
    <div className="flex flex-col gap-4">
      {message && (
        <p className={message.good ? "text-sm font-medium text-emerald-700 dark:text-emerald-400" : "text-sm text-destructive"} data-testid="decision-message">
          {message.text}
        </p>
      )}
      {requests.length === 0 ? (
        <p className="rounded-3xl border border-dashed p-10 text-center text-sm text-muted-foreground" data-testid="nothing-waiting">
          Nothing is waiting for approval.
        </p>
      ) : (
        requests.map((request) => (
          <Card key={request.id} data-testid="waiting-request">
            <CardContent className="flex flex-col gap-3">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <p className="text-lg font-semibold">
                  {request.kind === "DISCOUNT"
                    ? `Discount of ${nairaFromText(request.amount)}${request.details.discountPercent ? ` (${plainNumber(request.details.discountPercent)}%)` : ""} on ${nairaFromText(request.basis)}`
                    : `${nairaFromText(request.amount)} on credit, over the limit`}
                </p>
                <p className="text-sm text-muted-foreground">
                  Asked by {request.requestedByName} at {timeOf(request.requestedAt)} · waits until {timeOf(request.expiresAt)}
                </p>
              </div>
              {request.reason && <p className="text-sm">Reason: {request.reason}</p>}
              {request.details.customer && (
                <p className="text-sm">
                  Customer: {request.details.customer.name} — owes {nairaFromText(request.details.customer.owes)} now, limit{" "}
                  {nairaFromText(request.details.customer.creditLimit)}; would owe {nairaFromText(request.basis)} after this sale.
                </p>
              )}
              <ul className="rounded-2xl bg-muted/50 px-4 py-2 text-sm">
                {request.details.lines.map((line, index) => (
                  <li key={index} className="flex justify-between gap-3 py-0.5 tabular-nums">
                    <span>
                      {line.productName} — {plainNumber(line.quantity)} {line.unitName} × {nairaFromText(line.unitPrice)}
                    </span>
                    <span>{nairaFromText(line.lineTotal)}</span>
                  </li>
                ))}
                <li className="mt-1 flex justify-between gap-3 border-t pt-1 font-medium tabular-nums">
                  <span>Items come to</span>
                  <span>{nairaFromText(request.details.subtotal)}</span>
                </li>
              </ul>
              <div className="flex flex-wrap items-center gap-2">
                <Input
                  value={notes[request.id] ?? ""}
                  onChange={(event) => setNotes((current) => ({ ...current, [request.id]: event.target.value }))}
                  placeholder="Note for the record (optional)"
                  aria-label="Note (optional)"
                  maxLength={300}
                  autoComplete="off"
                  className="min-w-56 flex-1"
                />
                <Button type="button" onClick={() => decide(request, true)} disabled={pending}>
                  Approve
                </Button>
                <Button type="button" variant="outline" onClick={() => decide(request, false)} disabled={pending}>
                  Refuse
                </Button>
              </div>
            </CardContent>
          </Card>
        ))
      )}
    </div>
  );
}
