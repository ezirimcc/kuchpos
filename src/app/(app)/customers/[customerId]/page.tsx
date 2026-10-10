import { ArrowLeft, Users } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ActionForm, SubmitButton, TextField } from "@/components/action-form";
import { PageHeader } from "@/components/page-header";
import { Pagination } from "@/components/pagination";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatDateTime, nairaFromText } from "@/lib/format";
import { requirePagePermission } from "@/server/auth/request";
import { getCustomer, getCustomerStatement, getRepaymentOptions } from "@/server/business/customers";
import { NotFoundError, ValidationError } from "@/server/errors";
import { setCreditLimitAction, setCustomerActiveAction, updateCustomerAction } from "../actions";
import { CustomerFields } from "../customer-fields";
import { RepaymentForm } from "./repayment-form";

export const metadata: Metadata = { title: "Customer — KuchPos" };

const ENTRY_LABELS = { CREDIT_SALE: "Bought on credit", REPAYMENT: "Repayment", SALE_CANCELLED: "Credit sale cancelled", SALE_RETURN: "Goods returned" } as const;

export default async function CustomerPage({ params, searchParams }: PageProps<"/customers/[customerId]">) {
  const context = await requirePagePermission("customer.balance.view");
  const { customerId } = await params;
  const page = (await searchParams).page;

  let customer: Awaited<ReturnType<typeof getCustomer>>;
  try {
    customer = await getCustomer(context, { customerId });
  } catch (error) {
    // A customer of another business, or a made-up address, looks exactly like one that does not exist.
    if (error instanceof NotFoundError || error instanceof ValidationError) notFound();
    throw error;
  }
  const [statement, repaymentOptions] = await Promise.all([
    customer.canSeeStatement ? getCustomerStatement(context, { customerId, page: typeof page === "string" ? page : "" }) : null,
    customer.canRecordRepayment && customer.balance !== "0.00" ? getRepaymentOptions(context) : null,
  ]);

  return (
    <div className="flex max-w-5xl flex-col gap-5">
      <Link href="/customers" className="flex items-center gap-1 text-sm text-muted-foreground underline-offset-4 hover:underline">
        <ArrowLeft className="size-3.5" aria-hidden /> Customers
      </Link>
      <PageHeader
        icon={Users}
        title={
          <span className="flex flex-wrap items-center gap-2">
            {customer.name}
            {!customer.active && <Badge variant="destructive">Out of use</Badge>}
          </span>
        }
        description={[customer.phone, customer.address, customer.city, customer.state].filter(Boolean).join(" · ")}
      />

      <div className="grid gap-3 sm:grid-cols-3">
        <div className="bg-brand-gradient flex flex-col gap-1 rounded-3xl p-5 text-white">
          <span className="text-sm text-white/85">Owes now</span>
          <span className="text-3xl font-semibold tracking-tight tabular-nums" data-testid="customer-balance">
            {nairaFromText(customer.balance)}
          </span>
        </div>
        <div className="flex flex-col gap-1 rounded-3xl bg-card p-5 dark:border dark:border-border">
          <span className="text-sm text-muted-foreground">Credit limit</span>
          <span className="text-3xl font-semibold tracking-tight tabular-nums" data-testid="customer-limit">
            {customer.creditLimit === null ? "No credit" : nairaFromText(customer.creditLimit)}
          </span>
        </div>
        <div className="flex flex-col gap-1 rounded-3xl bg-card p-5 dark:border dark:border-border">
          <span className="text-sm text-muted-foreground">Can still take on credit</span>
          <span className="text-3xl font-semibold tracking-tight tabular-nums" data-testid="customer-available">
            {customer.availableCredit === null ? "—" : nairaFromText(customer.availableCredit)}
          </span>
        </div>
      </div>

      {repaymentOptions && (
        <Card>
          <CardContent>
            <RepaymentForm
              customerId={customer.id}
              owed={customer.balance}
              options={repaymentOptions}
              unpaidSales={customer.unpaidSales.map((sale) => ({ saleId: sale.saleId, receiptNumber: sale.receiptNumber, outstanding: sale.outstanding }))}
            />
          </CardContent>
        </Card>
      )}

      {customer.unpaidSales.length > 0 && (
        <div className="flex flex-col gap-2">
          <h2 className="px-1 text-base font-semibold">Credit sales not yet fully repaid</h2>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Sale</TableHead>
                <TableHead>When</TableHead>
                <TableHead className="text-right">On credit</TableHead>
                <TableHead className="text-right">Still to pay</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {customer.unpaidSales.map((sale) => (
                <TableRow key={sale.saleId} data-testid={`unpaid-${sale.receiptNumber}`}>
                  <TableCell className="font-medium">
                    <Link href={`/sales/${sale.saleId}`} className="text-link underline-offset-4 hover:underline">
                      {sale.receiptNumber}
                    </Link>
                  </TableCell>
                  <TableCell className="whitespace-nowrap">{formatDateTime(sale.soldAt)}</TableCell>
                  <TableCell className="text-right text-muted-foreground tabular-nums">{nairaFromText(sale.credit)}</TableCell>
                  <TableCell className="text-right font-semibold tabular-nums">{nairaFromText(sale.outstanding)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      {statement ? (
        <div className="flex flex-col gap-2" data-testid="statement">
          <h2 className="px-1 text-base font-semibold">Statement</h2>
          {statement.lines.length === 0 ? (
            <p className="rounded-3xl border border-dashed p-8 text-center text-sm text-muted-foreground">
              Nothing on this customer&apos;s account yet. Only credit sales and repayments appear here.
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>When</TableHead>
                  <TableHead>What</TableHead>
                  <TableHead>By</TableHead>
                  <TableHead className="text-right">Owed more</TableHead>
                  <TableHead className="text-right">Owed less</TableHead>
                  <TableHead className="text-right">Balance after</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {statement.lines.map((line) => (
                  <TableRow key={line.id} data-testid="statement-line">
                    <TableCell className="whitespace-nowrap">{formatDateTime(line.createdAt)}</TableCell>
                    <TableCell>
                      {ENTRY_LABELS[line.type]}{" "}
                      {line.saleId ? (
                        <Link href={`/sales/${line.saleId}`} className="text-link underline-offset-4 hover:underline">
                          {line.documentNumber}
                        </Link>
                      ) : (
                        <span className="text-muted-foreground">{line.documentNumber}</span>
                      )}
                      {line.note && <span className="block text-xs text-muted-foreground">{line.note}</span>}
                    </TableCell>
                    <TableCell className="text-muted-foreground">{line.createdByName}</TableCell>
                    <TableCell className="text-right tabular-nums">{line.amount.startsWith("-") ? "" : nairaFromText(line.amount)}</TableCell>
                    <TableCell className="text-right tabular-nums">{line.amount.startsWith("-") ? nairaFromText(line.amount.slice(1)) : ""}</TableCell>
                    <TableCell className="text-right font-medium tabular-nums">{nairaFromText(line.balanceAfter)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
          <Pagination path={`/customers/${customer.id}`} params={{}} noun="lines" {...statement} />
        </div>
      ) : (
        <p className="px-1 text-sm text-muted-foreground">The full statement is shown to the manager, admin and accountant.</p>
      )}

      {customer.canSetCreditLimit && (
        <Card>
          <CardHeader>
            <CardTitle>Credit limit</CardTitle>
            <CardDescription>
              The most this customer may owe. Leave it empty for no credit at all. A sale that would take them over the limit is
              refused at checkout unless a manager or admin makes it.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <ActionForm action={setCreditLimitAction}>
              <input type="hidden" name="customerId" value={customer.id} />
              <div className="max-w-xs">
                <TextField name="creditLimit" label="Credit limit (₦)" hint="For example 50000. Empty means no credit." defaultValue={customer.creditLimit ?? ""} inputMode="decimal" autoComplete="off" />
              </div>
              <SubmitButton className="mt-2">Save credit limit</SubmitButton>
            </ActionForm>
            {customer.limitHistory.length > 0 && (
              <ul className="mt-4 flex flex-col gap-1 border-t pt-3 text-xs text-muted-foreground">
                {customer.limitHistory.map((change) => (
                  <li key={change.id}>
                    {formatDateTime(change.createdAt)} — {change.changedByName} changed it from{" "}
                    {change.oldLimit === null ? "no credit" : nairaFromText(change.oldLimit)} to{" "}
                    {change.newLimit === null ? "no credit" : nairaFromText(change.newLimit)}
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      )}

      {customer.canManage && (
        <Card>
          <CardHeader>
            <CardTitle>Details</CardTitle>
            <CardDescription>Past sales keep the name and phone number they were made under.</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <ActionForm action={updateCustomerAction}>
              <input type="hidden" name="customerId" value={customer.id} />
              <CustomerFields values={customer} />
              <SubmitButton className="mt-2">Save details</SubmitButton>
            </ActionForm>
            <div className="border-t pt-4">
              <ActionForm action={setCustomerActiveAction} showSuccess={false}>
                <input type="hidden" name="customerId" value={customer.id} />
                <input type="hidden" name="active" value={customer.active ? "false" : "true"} />
                <SubmitButton variant={customer.active ? "destructive" : "outline"} size="sm">
                  {customer.active ? "Take this customer out of use" : "Bring this customer back"}
                </SubmitButton>
              </ActionForm>
              <p className="mt-1.5 text-xs text-muted-foreground">
                A customer out of use is no longer offered at checkout. They are never deleted, and can still repay what they owe.
              </p>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
