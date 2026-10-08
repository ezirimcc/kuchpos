import { UserPlus, Users } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { FilterDate, FilterSelect, FilterToggle, LiveSearch } from "@/components/filters";
import { PageHeader } from "@/components/page-header";
import { Pagination } from "@/components/pagination";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { nairaFromText } from "@/lib/format";
import { requirePagePermission } from "@/server/auth/request";
import { listCustomers } from "@/server/business/customers";

export const metadata: Metadata = { title: "Customers — KuchPos" };

function text(value: string | string[] | undefined): string {
  return typeof value === "string" ? value : "";
}

export default async function CustomersPage({ searchParams }: PageProps<"/customers">) {
  const context = await requirePagePermission("customer.balance.view");
  const params = await searchParams;
  const filters = {
    q: text(params.q),
    owing: text(params.owing),
    state: text(params.state),
    from: text(params.from),
    to: text(params.to),
    min: text(params.min),
    max: text(params.max),
    sort: text(params.sort),
  };
  const { q: search, ...others } = filters;
  const list = await listCustomers(context, { search, ...others, page: text(params.page) });
  const inDates = list.showsPurchases && (filters.from !== "" || filters.to !== "");
  const filtered = Object.values(filters).some((value) => value !== "");

  return (
    <div className="flex flex-col gap-5">
      <PageHeader icon={Users} title="Customers" description="The people this business sells to by name, and what each one owes.">
        {list.canManage && (
          <Link href="/customers/new" className={buttonVariants()}>
            <UserPlus className="size-4" aria-hidden /> New customer
          </Link>
        )}
      </PageHeader>

      <Suspense>
        <div className="flex flex-wrap items-center gap-3">
          <LiveSearch label="Search customers" placeholder="Search by name, phone, city or state" autoFocus />
          {list.states.length > 0 && (
            <FilterSelect name="state" label="State" allLabel="All states" options={list.states.map((state) => ({ value: state, label: state }))} />
          )}
          <FilterToggle name="owing" label="Only customers who owe" />
          <FilterSelect
            name="sort"
            label="Sort by"
            allLabel="Sort: name (A to Z)"
            options={[
              ...(list.showsPurchases
                ? [
                    { value: "purchases", label: "Sort: biggest purchases first" },
                    { value: "visits", label: "Sort: most visits first" },
                  ]
                : []),
              { value: "owes", label: "Sort: owes most first" },
            ]}
          />
        </div>
        {list.showsPurchases && (
          <div className="flex flex-wrap items-center gap-3">
            <span className="text-sm text-muted-foreground">Bought between</span>
            <FilterDate name="from" label="Bought from" />
            <FilterDate name="to" label="Bought up to" />
            <span className="text-sm text-muted-foreground">Total purchases</span>
            <LiveSearch name="min" label="Purchases of at least" placeholder="At least ₦" />
            <LiveSearch name="max" label="Purchases of at most" placeholder="At most ₦" />
            {filtered && (
              <Link href="/customers" className="text-sm text-link underline-offset-4 hover:underline">
                Clear filters
              </Link>
            )}
          </div>
        )}
      </Suspense>

      {list.customers.length === 0 ? (
        <p className="rounded-3xl border border-dashed p-10 text-center text-sm text-muted-foreground">
          {filtered ? "No customer matches. Try a different search." : "No customers yet. A sale with no customer chosen is a walk-in."}
        </p>
      ) : (
        <>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Phone</TableHead>
                <TableHead>City, state</TableHead>
                {list.showsPurchases && <TableHead className="text-right">{inDates ? "Purchases in these dates" : "Total purchases"}</TableHead>}
                {list.showsPurchases && <TableHead className="text-right">Visits</TableHead>}
                <TableHead className="text-right">Credit limit</TableHead>
                <TableHead className="text-right">Owes now</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {list.customers.map((customer) => (
                <TableRow key={customer.id} data-testid={`customer-row-${customer.name}`}>
                  <TableCell className="font-medium">
                    <Link href={`/customers/${customer.id}`} className="text-link underline-offset-4 hover:underline">
                      {customer.name}
                    </Link>
                    {!customer.active && (
                      <Badge variant="destructive" className="ml-2">
                        Out of use
                      </Badge>
                    )}
                  </TableCell>
                  <TableCell className="tabular-nums">{customer.phone}</TableCell>
                  <TableCell>{[customer.city, customer.state].filter(Boolean).join(", ") || "—"}</TableCell>
                  {customer.purchases !== null && (
                    <TableCell className="text-right tabular-nums" data-testid="customer-purchases">
                      {nairaFromText(customer.purchases)}
                    </TableCell>
                  )}
                  {customer.visits !== null && (
                    <TableCell className="text-right tabular-nums" data-testid="customer-visits">
                      {customer.visits}
                    </TableCell>
                  )}
                  <TableCell className="text-right text-muted-foreground tabular-nums">
                    {customer.creditLimit === null ? "No credit" : nairaFromText(customer.creditLimit)}
                  </TableCell>
                  <TableCell className={customer.balance === "0.00" ? "text-right text-muted-foreground tabular-nums" : "text-right font-semibold tabular-nums"}>
                    {nairaFromText(customer.balance)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          {list.totalPurchases !== null && (
            <p className="px-2 text-right text-sm text-muted-foreground">
              Bought by {filtered ? "the customers that match" : "all customers"}
              {inDates ? ", in these dates" : ""}{" "}
              <span className="ml-2 text-2xl font-semibold text-foreground tabular-nums" data-testid="total-purchases">
                {nairaFromText(list.totalPurchases)}
              </span>
            </p>
          )}
          <p className="px-2 text-right text-sm text-muted-foreground">
            Owed by {filtered ? "the customers that match" : "all customers"}{" "}
            <span className="ml-2 text-2xl font-semibold text-foreground tabular-nums" data-testid="total-owed">
              {nairaFromText(list.totalOwed)}
            </span>
          </p>
        </>
      )}

      <Pagination path="/customers" params={filters} noun="customers" {...list} />
    </div>
  );
}
