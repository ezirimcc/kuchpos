import { Wallet } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { Suspense } from "react";
import { FilterDate, FilterSelect } from "@/components/filters";
import { PageHeader } from "@/components/page-header";
import { Pagination } from "@/components/pagination";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatDateTime, tillSessionNumber } from "@/lib/format";
import { requirePageContext } from "@/server/auth/request";
import { listTillSessions } from "@/server/business/till";
import { can } from "@/server/permissions";
import { Difference } from "./difference";

export const metadata: Metadata = { title: "Till sessions — KuchPos" };

function text(value: string | string[] | undefined): string {
  return typeof value === "string" ? value : "";
}

export default async function TillSessionsPage({ searchParams }: PageProps<"/till/sessions">) {
  const context = await requirePageContext();
  if (!can(context, "till.reviewAny") && !can(context, "till.operateOwn")) redirect("/");
  const params = await searchParams;
  const filters = { status: text(params.status), from: text(params.from), to: text(params.to) };
  const list = await listTillSessions(context, { ...filters, page: text(params.page) });
  const filtered = Object.values(filters).some((value) => value !== "");

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        icon={Wallet}
        title="Till sessions"
        description={
          list.ownOnly
            ? "The till sessions you opened, newest first. A manager checks each count against the sales."
            : "Every till session, newest first: who ran it, and whether the cash matched at closing."
        }
      >
        {list.canOperate && (
          <Link href="/till" className={buttonVariants()}>
            <Wallet className="size-4" aria-hidden /> This checkout&apos;s till
          </Link>
        )}
      </PageHeader>

      <Suspense>
        <div className="flex flex-wrap items-center gap-3">
          <FilterSelect
            name="status"
            label="Filter by status"
            allLabel="Open and closed"
            options={[
              { value: "open", label: "Open" },
              { value: "closed", label: "Closed" },
            ]}
          />
          <FilterDate name="from" label="From" />
          <FilterDate name="to" label="To" />
          {filtered && (
            <Link href="/till/sessions" className="text-sm text-link underline-offset-4 hover:underline">
              Clear filters
            </Link>
          )}
        </div>
      </Suspense>

      {list.sessions.length === 0 ? (
        <p className="rounded-3xl border border-dashed p-10 text-center text-sm text-muted-foreground">
          {filtered ? "No till session matches these filters." : "No till has been opened yet."}
        </p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Session</TableHead>
              <TableHead>Checkout</TableHead>
              <TableHead>Opened</TableHead>
              <TableHead>Closed</TableHead>
              <TableHead className="text-right">Cash against count</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {list.sessions.map((session) => (
              <TableRow key={session.id} data-testid={`till-row-${session.number}`}>
                <TableCell className="font-medium">
                  <Link href={`/till/sessions/${session.id}`} className="text-link underline-offset-4 hover:underline">
                    {tillSessionNumber(session.number)}
                  </Link>
                </TableCell>
                <TableCell>{session.terminalCode}</TableCell>
                <TableCell>
                  {formatDateTime(session.openedAt)} <span className="text-muted-foreground">· {session.openedByName}</span>
                </TableCell>
                <TableCell>
                  {session.closedAt ? (
                    <>
                      {formatDateTime(session.closedAt)} <span className="text-muted-foreground">· {session.closedByName}</span>
                    </>
                  ) : (
                    <Badge>Open now</Badge>
                  )}
                </TableCell>
                <TableCell className="text-right">
                  {session.difference !== null ? <Difference amount={session.difference} /> : session.closedAt ? "Counted" : "—"}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}

      <Pagination path="/till/sessions" params={filters} noun="till sessions" {...list} />
    </div>
  );
}
