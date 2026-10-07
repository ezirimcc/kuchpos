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

  const facts: [string, string][] = [
    ["Checkout", session.terminalCode],
    ["Opened", `${formatDateTime(session.openedAt)} · ${session.openedByName}`],
    ["Closed", session.closedAt ? `${formatDateTime(session.closedAt)} · ${session.closedByName}` : "Still open"],
    ["Sales", `${session.saleCount} · ${nairaFromText(session.salesTotal)}`],
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
            {open ? <Badge>Open now</Badge> : <Difference amount={session.difference ?? "0.00"} />}
          </span>
        }
        description={
          open
            ? "This till is still open. Its cash is counted when it is closed."
            : "What was taken, and how the cash counted in the drawer compared with what should have been there."
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
              {open && session.saleCount > 0 ? "Cash takings are shown when the till is closed." : "Nothing has been taken in this session."}
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
          {open && session.expectedCash === null && session.byMethod.length > 0 && (
            <p className="px-1 text-xs text-muted-foreground">Cash takings are shown when the till is closed.</p>
          )}
        </div>

        <Card>
          <CardContent className="flex flex-col gap-2 tabular-nums">
            <h2 className="text-base font-semibold">Cash in the drawer</h2>
            <p className="flex justify-between gap-3 text-sm">
              <span className="text-muted-foreground">Opening float</span>
              <span>{nairaFromText(session.openingFloat)}</span>
            </p>
            <p className="flex justify-between gap-3 text-sm">
              <span className="text-muted-foreground">Should be there (float + cash sales − change)</span>
              <span data-testid="till-expected">{session.expectedCash === null ? "Shown at closing" : nairaFromText(session.expectedCash)}</span>
            </p>
            <p className="flex justify-between gap-3 text-sm">
              <span className="text-muted-foreground">Counted</span>
              <span data-testid="till-counted">{session.countedCash === null ? "Not counted yet" : nairaFromText(session.countedCash)}</span>
            </p>
            {session.difference !== null && (
              <p className="flex items-center justify-between gap-3 border-t pt-2 text-sm font-medium">
                <span>Result</span>
                <Difference amount={session.difference} />
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
    </div>
  );
}
