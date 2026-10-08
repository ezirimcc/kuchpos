import { UserPlus, Users } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { FilterToggle, LiveSearch } from "@/components/filters";
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
  const filters = { q: text(params.q), owing: text(params.owing) };
  const list = await listCustomers(context, { search: filters.q, owing: filters.owing, page: text(params.page) });
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
          <LiveSearch label="Search customers" placeholder="Search by name, phone or city" autoFocus />
          <FilterToggle name="owing" label="Only customers who owe" />
        </div>
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
                <TableHead>City</TableHead>
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
                  <TableCell>{customer.city ?? "—"}</TableCell>
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
