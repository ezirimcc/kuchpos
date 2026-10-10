import { ShoppingCart, Wallet } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { PageHeader } from "@/components/page-header";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { formatDateTime, nairaFromText, tillSessionNumber } from "@/lib/format";
import { requirePageContext } from "@/server/auth/request";
import { getTill } from "@/server/business/till";
import { can } from "@/server/permissions";
import { TillCashForm } from "./till-cash-form";
import { CloseTillForm, OpenTillForm, TerminalChooser } from "./till-forms";

export const metadata: Metadata = { title: "Till — KuchPos" };

export default async function TillPage({ searchParams }: PageProps<"/till">) {
  const context = await requirePageContext();
  // Those who only review tills (the accountant) go straight to the list of sessions.
  if (!can(context, "till.operateOwn")) redirect(can(context, "till.reviewAny") ? "/till/sessions" : "/");

  const asked = (await searchParams).terminal;
  const first = await getTill(context, { terminalId: typeof asked === "string" ? asked : "" });
  // With a single terminal there is nothing to choose.
  const only = first.terminals.length === 1 ? first.terminals[0] : undefined;
  const till = only && !first.open ? await getTill(context, { terminalId: only.id }) : first;
  const terminal = till.terminals.find((candidate) => candidate.id === asked) ?? only;

  return (
    <div className="flex max-w-4xl flex-col gap-5">
      <PageHeader
        icon={Wallet}
        title="Till"
        description="Open the till with the cash in the drawer before selling; close it with a count at the end. One till per checkout."
      >
        <Link href="/till/sessions" className={buttonVariants({ variant: "outline" })}>
          Past till sessions
        </Link>
      </PageHeader>

      {till.terminals.length === 0 && (
        <p className="rounded-3xl border border-dashed p-10 text-center text-sm text-muted-foreground">
          This business has no checkout terminal in use. Ask the admin to add one under Settings.
        </p>
      )}

      <TerminalChooser terminals={till.terminals} current={terminal?.id ?? ""} />

      {terminal && !till.open && (
        <Card>
          <CardContent className="flex flex-col gap-4">
            <div>
              <h2 className="text-base font-semibold" data-testid="till-status">
                The till of {terminal.code} is closed
              </h2>
              <p className="mt-0.5 text-sm text-muted-foreground">Nothing can be sold at this checkout until it is opened.</p>
            </div>
            <OpenTillForm terminalId={terminal.id} terminalCode={terminal.code} />
          </CardContent>
        </Card>
      )}

      {terminal && till.open && (
        <>
          <Card>
            <CardContent className="flex flex-col gap-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <h2 className="text-base font-semibold" data-testid="till-status">
                    The till of {till.open.terminalCode} is open
                  </h2>
                  <p className="mt-0.5 text-sm text-muted-foreground">
                    {tillSessionNumber(till.open.number)} · opened by {till.open.openedByName} on {formatDateTime(till.open.openedAt)}
                  </p>
                </div>
                {can(context, "sale.create") && (
                  <Link href="/sell" className={buttonVariants()}>
                    <ShoppingCart className="size-4" aria-hidden /> Go to the checkout
                  </Link>
                )}
              </div>
              <dl className="grid gap-x-8 gap-y-4 sm:grid-cols-3">
                <div>
                  <dt className="text-xs text-muted-foreground">Opening float</dt>
                  <dd className="mt-0.5 font-medium tabular-nums">{nairaFromText(till.open.openingFloat)}</dd>
                </div>
                <div>
                  <dt className="text-xs text-muted-foreground">Sales so far</dt>
                  <dd className="mt-0.5 font-medium tabular-nums" data-testid="till-sale-count">
                    {till.open.saleCount}
                  </dd>
                </div>
                {till.open.expectedCash !== null && (
                  <div>
                    <dt className="text-xs text-muted-foreground">Cash that should be in the drawer</dt>
                    <dd className="mt-0.5 font-medium tabular-nums" data-testid="till-expected-now">
                      {nairaFromText(till.open.expectedCash)}
                    </dd>
                  </div>
                )}
              </dl>
              <Link href={`/till/sessions/${till.open.id}`} className="w-fit text-sm text-link underline-offset-4 hover:underline">
                See this session&apos;s takings so far
              </Link>
            </CardContent>
          </Card>

          {can(context, "till.operateOwn") && (
            <Card>
              <CardContent>
                <TillCashForm sessionId={till.open.id} countsAtOnce={till.open.cashCountsAtOnce} requests={till.open.cashRequests} />
              </CardContent>
            </Card>
          )}

          {till.open.canClose ? (
            <Card>
              <CardContent>
                <CloseTillForm sessionId={till.open.id} />
              </CardContent>
            </Card>
          ) : (
            <p className="px-1 text-sm text-muted-foreground">
              This till was opened by {till.open.openedByName}. Only they, a manager or an admin can close it.
            </p>
          )}
        </>
      )}
    </div>
  );
}
