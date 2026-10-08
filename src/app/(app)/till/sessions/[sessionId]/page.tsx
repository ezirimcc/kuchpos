import { ArrowLeft, Wallet } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatDateTime, nairaFromText, tillSessionNumber } from "@/lib/format";
import { paymentKindLabel } from "@/lib/payment-kinds";
import { requirePageContext } from "@/server/auth/request";
import { getTillSession } from "@/server/business/till";
import { ForbiddenError, NotFoundError, ValidationError } from "@/server/errors";
import { can } from "@/server/permissions";
import { RecountTillForm } from "../../till-forms";
import { Difference } from "../difference";

export const metadata: Metadata = { title: "Till session — KuchPos" };

export default async function TillSessionPage({ params }: PageProps<"/till/sessions/[sessionId]">) {
  const context = await requirePageContext();
  const { sessionId } = await params;

  let session: Awaited<ReturnType<typeof getTillSession>>;
  try {
    session = await getTillSession(context, { sessionId });
  } catch (error) {
    if (error instanceof ForbiddenError) redirect("/");
    // Someone else's session (for a cashier), another business's, or a made-up address: all "not found".
    if (error instanceof NotFoundError || error instanceof ValidationError) notFound();
    throw error;
  }
  const open = session.closedAt === null;
  // Only those who review tills are shown the expected cash and whether a count balanced (SPEC C51).
  const reviewer = can(context, "till.reviewAny");

  const facts: [string, string][] = [
    ["Checkout", session.terminalCode],
    ["Opened", `${formatDateTime(session.openedAt)} · ${session.openedByName}`],
    ["Closed", session.closedAt ? `${formatDateTime(session.closedAt)} · ${session.closedByName}` : "Still open"],
    [
      "Sales",
      `${session.saleCount} · ${nairaFromText(session.salesTotal)}` +
        (session.cancelledCount > 0 ? ` (and ${session.cancelledCount} cancelled)` : ""),
    ],
  ];

  return (
    <div className="flex max-w-4xl flex-col gap-5">
      <Link href="/till/sessions" className="flex items-center gap-1 text-sm text-muted-foreground underline-offset-4 hover:underline">
        <ArrowLeft className="size-3.5" aria-hidden /> Till sessions
      </Link>
      <PageHeader
        icon={Wallet}
        title={
          <span className="flex flex-wrap items-center gap-2">
            Till session {tillSessionNumber(session.number)}
            {open ? <Badge>Open now</Badge> : session.difference !== null ? <Difference amount={session.difference} /> : <Badge variant="secondary">Closed</Badge>}
          </span>
        }
        description={
          open
            ? "This till is still open. Its cash is counted when it is closed."
            : reviewer
              ? "What was taken, and how the cash counted in the drawer compared with what should have been there."
              : "This till is closed and its cash has been counted. A manager checks the count against the sales."
        }
      />

      <Card>
        <CardContent>
          <dl className="grid gap-x-8 gap-y-4 sm:grid-cols-2 lg:grid-cols-4">
            {facts.map(([label, value]) => (
              <div key={label}>
                <dt className="text-xs text-muted-foreground">{label}</dt>
                <dd className="mt-0.5 font-medium">{value}</dd>
              </div>
            ))}
          </dl>
          {session.closingNote && <p className="mt-4 border-t pt-4 text-sm">Note at closing: {session.closingNote}</p>}
        </CardContent>
      </Card>

      <div className="grid items-start gap-5 lg:grid-cols-2">
        <div className="flex flex-col gap-2">
          <h2 className="px-1 text-base font-semibold">Taken, by payment method</h2>
          {session.byMethod.length === 0 ? (
            <p className="rounded-3xl border border-dashed p-6 text-center text-sm text-muted-foreground">
              {!reviewer && session.saleCount > 0 ? "Cash takings are checked by a manager." : "Nothing has been taken in this session."}
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Method</TableHead>
                  <TableHead className="text-right">Payments</TableHead>
                  <TableHead className="text-right">Amount</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {session.byMethod.map((entry) => (
                  <TableRow key={entry.methodName} data-testid={`till-method-${entry.methodName}`}>
                    <TableCell>
                      <span className="font-medium">{entry.methodName}</span>{" "}
                      <span className="text-muted-foreground">· {paymentKindLabel(entry.kind)}</span>
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{entry.count}</TableCell>
                    <TableCell className="text-right font-medium tabular-nums">{nairaFromText(entry.amount)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
          {!reviewer && session.byMethod.length > 0 && (
            <p className="px-1 text-xs text-muted-foreground">Cash takings are not shown here; a manager checks them.</p>
          )}
        </div>

        <Card>
          <CardContent className="flex flex-col gap-2 tabular-nums">
            <h2 className="text-base font-semibold">Cash in the drawer</h2>
            <p className="flex justify-between gap-3 text-sm">
              <span className="text-muted-foreground">Opening float</span>
              <span>{nairaFromText(session.openingFloat)}</span>
            </p>
            {session.floatBreakdown.length > 0 && (
              <p className="-mt-1 text-xs text-muted-foreground" data-testid="till-float-notes">
                {session.floatBreakdown.join(" · ")}
              </p>
            )}
            {session.cashRefunded !== null && session.cashRefunded !== "0.00" && (
              <p className="flex justify-between gap-3 text-sm">
                <span className="text-muted-foreground">Cash refunded for cancelled sales</span>
                <span data-testid="till-cash-refunded">−{nairaFromText(session.cashRefunded)}</span>
              </p>
            )}
            {reviewer && (
              <p className="flex justify-between gap-3 text-sm">
                <span className="text-muted-foreground">Should be there (float + cash sales − change − refunds)</span>
                <span data-testid="till-expected">{nairaFromText(session.expectedCash ?? "0.00")}</span>
              </p>
            )}
            <p className="flex justify-between gap-3 text-sm">
              <span className="text-muted-foreground">Counted at closing{session.closedByName ? ` by ${session.closedByName}` : ""}</span>
              <span data-testid="till-counted">{session.countedCash === null ? "Not counted yet" : nairaFromText(session.countedCash)}</span>
            </p>
            {session.closingBreakdown.length > 0 && (
              <p className="-mt-1 text-xs text-muted-foreground" data-testid="till-closing-notes">
                {session.closingBreakdown.join(" · ")}
              </p>
            )}
            {session.closingDifference !== null && (
              <p className="flex items-center justify-between gap-3 border-t pt-2 text-sm font-medium">
                <span>Result of the closing count</span>
                <span data-testid="till-closing-result">
                  <Difference amount={session.closingDifference} />
                </span>
              </p>
            )}
            {session.recounts.map((recount, index) => (
              <div key={recount.id} className="flex flex-col gap-1 border-t pt-2 text-sm" data-testid={`till-recount-${index + 1}`}>
                <p className="flex items-center justify-between gap-3 font-medium">
                  <span>
                    Recount {index + 1}: {nairaFromText(recount.countedCash)}
                  </span>
                  <Difference amount={recount.difference} />
                </p>
                <p className="text-xs text-muted-foreground">
                  {recount.recountedByName}, {formatDateTime(recount.createdAt)} · {recount.note}
                </p>
                {recount.breakdown.length > 0 && <p className="text-xs text-muted-foreground">{recount.breakdown.join(" · ")}</p>}
              </div>
            ))}
            {!reviewer && !open && (
              <p className="border-t pt-2 text-xs text-muted-foreground" data-testid="till-result-hidden">
                A manager checks this count against the sales.
              </p>
            )}
            {session.canClose && (
              <Link href={`/till?terminal=${session.terminalId}`} className="mt-2 w-fit text-sm text-link underline-offset-4 hover:underline">
                Close this till from the Till page
              </Link>
            )}
          </CardContent>
        </Card>
      </div>

      {session.canRecount && (
        <Card>
          <CardContent>
            <RecountTillForm sessionId={session.id} />
          </CardContent>
        </Card>
      )}
    </div>
  );
}
