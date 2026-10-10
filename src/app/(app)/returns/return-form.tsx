"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";
import { ApprovalBox } from "@/app/(app)/sell/approval-box";
import { useRememberedTerminal } from "@/components/terminal-choice";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Decimal } from "@/lib/decimal";
import { nairaFromText, plainNumber } from "@/lib/format";
import { formatNaira, roundMoney, sumMoney } from "@/lib/money";
import type { ReturnOptions } from "@/server/business/returns";
import { approveAtScreenAction, requestApprovalAction, withdrawApprovalRequestAction } from "../sales/actions";
import { postReturnAction } from "./actions";

type Place = "SHELF" | "STOREROOM" | "WRITTEN_OFF";
type Entry = { quantity: string; disposition: Place };
type Approval = { id: string; by: string; for: string };
type Sent = { requestId: string; for: string; state: "waiting" | "refused" | "expired"; text?: string };

const isQuantity = (text: string) => /^\d+(\.\d{1,3})?$/.test(text.trim()) && new Decimal(text.trim()).greaterThan(0);

/**
 * Taking goods back against a sale (C62). Everything shown is worked out here for the
 * person's eyes; the server works it all out again when the return is sent.
 */
export function ReturnForm({ options }: { options: ReturnOptions }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  // The return's unique ID, made before anything is sent: it can only ever be saved once.
  const [requestId] = useState(() => crypto.randomUUID());
  const [entries, setEntries] = useState<Record<string, Entry>>({});
  const [reason, setReason] = useState("");
  const [methodId, setMethodId] = useState(options.paymentMethods[0]?.id ?? "");
  const [reference, setReference] = useState("");
  const remembered = useRememberedTerminal();
  const [chosenTill, setChosenTill] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [approval, setApproval] = useState<Approval | null>(null);
  const [asking, setAsking] = useState(false);
  const [approvalError, setApprovalError] = useState<string | null>(null);
  const [sent, setSent] = useState<Sent | null>(null);

  const view = options.lines.map((line) => {
    const entry = entries[line.saleLineId] ?? { quantity: "", disposition: "SHELF" as Place };
    const typed = entry.quantity.trim();
    const remaining = new Decimal(line.returnable);
    const valid = typed !== "" && isQuantity(typed) && (line.allowsFraction || /^\d+$/.test(typed)) && new Decimal(typed).lessThanOrEqualTo(remaining);
    let refund: Decimal | null = null;
    if (valid) {
      const quantity = new Decimal(typed);
      const left = new Decimal(line.paid).minus(line.refunded);
      refund = quantity.equals(remaining) ? left : Decimal.min(roundMoney(new Decimal(line.paid).times(quantity).dividedBy(line.sold)), left);
    }
    return { line, entry, typed, valid, bad: typed !== "" && !valid, refund };
  });
  const chosen = view.filter((row) => row.valid);
  const anyBad = view.some((row) => row.bad);
  const refundTotal = sumMoney(chosen.map((row) => row.refund!));
  const offDebt = Decimal.min(refundTotal, new Decimal(options.owedOnSale));
  const toHandBack = refundTotal.minus(offDebt);
  const method = options.paymentMethods.find((candidate) => candidate.id === methodId);
  const isCash = method?.kind === "CASH";
  const tillTerminal =
    [chosenTill, remembered, options.sale.terminalId].find((id) => id && options.openTills.some((till) => till.terminalId === id)) ??
    (options.openTills.length === 1 ? options.openTills[0].terminalId : "");

  const lines = chosen.map((row) => ({ saleLineId: row.line.saleLineId, quantity: row.typed, disposition: row.entry.disposition }));
  const payload = () => ({
    requestId,
    saleId: options.sale.id,
    reason: reason.trim(),
    lines,
    refundMethodId: toHandBack.greaterThan(0) ? methodId : "",
    refundReference: toHandBack.greaterThan(0) && !isCash ? reference.trim() : "",
    terminalId: toHandBack.greaterThan(0) && isCash ? tillTerminal : "",
  });
  // An approval counts only while the return is still exactly what was approved.
  const key = JSON.stringify([requestId, lines, toHandBack.greaterThan(0) ? methodId : ""]);
  const approved = approval?.for === key;
  const sentNow = sent && sent.for === key ? sent : null;
  const reasonGiven = reason.trim().length >= 3;
  const refundSound = !toHandBack.greaterThan(0) || (!!method && (!isCash || tillTerminal !== ""));
  const complete = chosen.length > 0 && !anyBad && reasonGiven && refundSound;
  const ready = complete && (!options.needsApproval || approved);

  function change(saleLineId: string, patch: Partial<Entry>) {
    setErrors({});
    setEntries((current) => ({ ...current, [saleLineId]: { ...(current[saleLineId] ?? { quantity: "", disposition: "SHELF" }), ...patch } }));
  }

  // While a request is waiting at a manager's computer, this screen asks what has become of it.
  const waiting = sent?.state === "waiting" ? sent : null;
  const waitingFits = !!waiting && waiting.for === key;
  useEffect(() => {
    if (!waiting) return;
    if (!waitingFits) {
      void withdrawApprovalRequestAction(waiting.requestId);
      return;
    }
    let stopped = false;
    async function look() {
      try {
        const response = await fetch(`/api/approvals/requests/${waiting!.requestId}`, { cache: "no-store" });
        if (stopped || !response.ok) return;
        const answer = (await response.json()) as { status: string; approvalId?: string; approvedByName?: string; refusedByName?: string; note?: string | null };
        if (stopped) return;
        if (answer.status === "APPROVED" && answer.approvalId) {
          setApproval({ id: answer.approvalId, by: answer.approvedByName ?? "", for: waiting!.for });
          setSent(null);
        } else if (answer.status === "REFUSED") {
          setSent({ ...waiting!, state: "refused", text: `Refused by ${answer.refusedByName}${answer.note ? `: ${answer.note}` : "."}` });
        } else if (answer.status === "WITHDRAWN") {
          setSent(null);
        } else if (answer.status === "EXPIRED") {
          setSent({ ...waiting!, state: "expired", text: "Nobody answered within 10 minutes. Send it again, or ask a manager to approve here." });
        }
      } catch {
        // No connection just now; try again next time.
      }
    }
    const timer = window.setInterval(look, 3000);
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, [waiting, waitingFits]);

  function show(result: { status: string; message?: string; fieldErrors?: Record<string, string> }) {
    if (result.status !== "error") return;
    setMessage(result.message ?? null);
    setErrors(result.fieldErrors ?? {});
  }

  function approveHere(username: string, password: string) {
    if (pending) return;
    const approvedFor = key;
    setApprovalError(null);
    startTransition(async () => {
      const result = await approveAtScreenAction({ kind: "RETURN", saleRequestId: requestId, return: payload(), username, password });
      if (result.status === "success" && result.approval) {
        setApproval({ id: result.approval.id, by: result.approval.approvedByName, for: approvedFor });
        setAsking(false);
        if (sent?.state === "waiting") void withdrawApprovalRequestAction(sent.requestId);
        setSent(null);
      } else if (result.status === "error") {
        const { password: wrong, ...others } = result.fieldErrors;
        setApprovalError(wrong ?? Object.values(others)[0] ?? result.message);
        setErrors(others);
      }
    });
  }

  function sendToManager() {
    if (pending) return;
    const approvedFor = key;
    setAsking(false);
    startTransition(async () => {
      const result = await requestApprovalAction({ kind: "RETURN", saleRequestId: requestId, return: payload() });
      if (result.status === "success" && result.requestId) setSent({ requestId: result.requestId, for: approvedFor, state: "waiting" });
      else show(result);
    });
  }

  function save(event: React.FormEvent) {
    event.preventDefault();
    if (pending || !ready) return;
    setMessage(null);
    setErrors({});
    startTransition(async () => {
      const result = await postReturnAction({ ...payload(), approvalId: approved ? approval!.id : "" });
      if (result.status === "success" && result.returnId) router.push(`/returns/${result.returnId}?done=1`);
      else show(result);
    });
  }

  const lineProblem = (saleLineId: string) => {
    const index = lines.findIndex((line) => line.saleLineId === saleLineId);
    return index < 0 ? undefined : (errors[`lines.${index}.quantity`] ?? errors[`lines.${index}.disposition`]);
  };

  return (
    <form onSubmit={save} className="flex flex-col gap-5">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Item</TableHead>
            <TableHead className="text-right">Sold</TableHead>
            <TableHead className="text-right">Already returned</TableHead>
            <TableHead>Coming back now</TableHead>
            <TableHead>Where it goes</TableHead>
            <TableHead className="text-right">Refund</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {view.map(({ line, entry, bad, refund }) => (
            <TableRow key={line.saleLineId} data-testid={`return-line-${line.lineNumber}`}>
              <TableCell className="font-medium">{line.productName}</TableCell>
              <TableCell className="text-right tabular-nums">
                {plainNumber(line.sold)} {line.unitName}
              </TableCell>
              <TableCell className="text-right tabular-nums">{plainNumber(line.returned)}</TableCell>
              <TableCell>
                {line.returnable === "0.000" ? (
                  <span className="text-sm text-muted-foreground">All returned</span>
                ) : (
                  <div className="flex flex-col gap-1">
                    <Input
                      value={entry.quantity}
                      onChange={(event) => change(line.saleLineId, { quantity: event.target.value })}
                      inputMode="decimal"
                      autoComplete="off"
                      aria-label={`How many came back: ${line.productName} (${line.unitName})`}
                      aria-invalid={bad || !!lineProblem(line.saleLineId)}
                      placeholder={`0 of ${plainNumber(line.returnable)}`}
                      className="w-32 text-right tabular-nums"
                    />
                    {bad && <span className="text-xs text-destructive">Enter a number up to {plainNumber(line.returnable)}.</span>}
                    {lineProblem(line.saleLineId) && <span className="text-xs text-destructive">{lineProblem(line.saleLineId)}</span>}
                  </div>
                )}
              </TableCell>
              <TableCell>
                {line.returnable !== "0.000" && (
                  <NativeSelect
                    value={entry.disposition}
                    onChange={(event) => change(line.saleLineId, { disposition: event.target.value as Place })}
                    aria-label={`Where it goes: ${line.productName} (${line.unitName})`}
                    className="w-56"
                  >
                    <option value="SHELF">Back on the Shelf</option>
                    {options.hasStoreroom && <option value="STOREROOM">Back to the Storeroom</option>}
                    <option value="WRITTEN_OFF">Damaged — written off</option>
                  </NativeSelect>
                )}
              </TableCell>
              <TableCell className="text-right font-medium tabular-nums">{refund ? formatNaira(refund) : "—"}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>

      <Card>
        <CardContent className="flex max-w-2xl flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="return-reason">Why the goods are coming back</Label>
            <Input
              id="return-reason"
              value={reason}
              onChange={(event) => {
                setReason(event.target.value);
                setErrors({});
              }}
              maxLength={300}
              autoComplete="off"
              aria-invalid={!!errors.reason}
            />
            {errors.reason && <p className="text-xs text-destructive">{errors.reason}</p>}
          </div>

          <div>
            <p className="text-sm text-muted-foreground">To refund</p>
            <p className="text-3xl font-semibold tracking-tight tabular-nums" data-testid="refund-total">
              {chosen.length > 0 ? formatNaira(refundTotal) : "—"}
            </p>
            {offDebt.greaterThan(0) && (
              <p className="mt-1 text-sm" data-testid="refund-off-debt">
                {formatNaira(offDebt)} comes off what {options.sale.customerName ?? "the customer"} still owes on this sale ({nairaFromText(options.owedOnSale)}).
                {toHandBack.greaterThan(0) ? ` ${formatNaira(toHandBack)} is handed back.` : " Nothing is handed back."}
              </p>
            )}
          </div>

          {toHandBack.greaterThan(0) && (
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="refund-method">Handed back by</Label>
                <NativeSelect
                  id="refund-method"
                  value={methodId}
                  onChange={(event) => {
                    setMethodId(event.target.value);
                    setErrors({});
                  }}
                  aria-invalid={!!errors.refundMethodId}
                >
                  {options.paymentMethods.map((candidate) => (
                    <option key={candidate.id} value={candidate.id}>
                      {candidate.name}
                    </option>
                  ))}
                </NativeSelect>
                {errors.refundMethodId && <p className="text-xs text-destructive">{errors.refundMethodId}</p>}
              </div>
              {isCash ? (
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="refund-till">The cash comes out of the till of</Label>
                  <NativeSelect id="refund-till" value={tillTerminal} onChange={(event) => setChosenTill(event.target.value)} aria-invalid={!!errors.terminalId}>
                    <option value="">Choose a checkout</option>
                    {options.openTills.map((till) => (
                      <option key={till.terminalId} value={till.terminalId}>
                        {till.code} — {till.name}
                      </option>
                    ))}
                  </NativeSelect>
                  {options.openTills.length === 0 && <p className="text-xs text-destructive">No till is open. Open a till, or hand the money back another way.</p>}
                  {errors.terminalId && <p className="text-xs text-destructive">{errors.terminalId}</p>}
                </div>
              ) : (
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="refund-reference">Reference (optional)</Label>
                  <Input id="refund-reference" value={reference} onChange={(event) => setReference(event.target.value)} maxLength={60} autoComplete="off" />
                </div>
              )}
            </div>
          )}

          {options.needsApproval && complete && (
            <div className="flex flex-col gap-2 rounded-2xl border p-3" data-testid="return-approval">
              {approved ? (
                <p className="text-sm font-medium text-emerald-700 dark:text-emerald-400" data-testid="return-approved">
                  Approved by {approval!.by}. Save the return within 10 minutes; changing it needs a new approval.
                </p>
              ) : asking ? (
                <ApprovalBox
                  what={`a return of ${formatNaira(refundTotal)} against sale ${options.sale.receiptNumber}`}
                  busy={pending}
                  error={approvalError}
                  onApprove={approveHere}
                  onCancel={() => setAsking(false)}
                />
              ) : (
                <>
                  <p className="text-sm">A manager, admin or owner must approve this return.</p>
                  {sentNow?.state === "waiting" && (
                    <p className="text-xs font-medium" data-testid="return-sent">
                      Sent. Waiting for a manager to approve it on their own computer…
                    </p>
                  )}
                  {sentNow && sentNow.state !== "waiting" && (
                    <p className="text-xs text-destructive" data-testid="return-not-approved">
                      {sentNow.text}
                    </p>
                  )}
                  <div className="flex flex-wrap gap-2">
                    <Button
                      type="button"
                      size="sm"
                      onClick={() => {
                        setApprovalError(null);
                        setAsking(true);
                      }}
                      data-testid="ask-return-approval"
                    >
                      Approve here
                    </Button>
                    {sentNow?.state === "waiting" ? (
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        onClick={() => {
                          void withdrawApprovalRequestAction(sentNow.requestId);
                          setSent(null);
                        }}
                      >
                        Take the request back
                      </Button>
                    ) : (
                      <Button type="button" size="sm" variant="outline" disabled={pending} onClick={sendToManager} data-testid="send-return-approval">
                        Send to a manager
                      </Button>
                    )}
                  </div>
                </>
              )}
              {errors.approvalId && <p className="text-xs text-destructive">{errors.approvalId}</p>}
            </div>
          )}

          {message && <Alert variant="destructive">{message}</Alert>}
          {errors.lines && <Alert variant="destructive">{errors.lines}</Alert>}
          <div>
            <Button type="submit" size="lg" disabled={pending || !ready} data-testid="save-return">
              {pending ? "Saving…" : "Save the return"}
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            The sale itself is never changed: the return is saved beside it, and can be saved only once however many times the button is pressed.
          </p>
        </CardContent>
      </Card>
    </form>
  );
}
