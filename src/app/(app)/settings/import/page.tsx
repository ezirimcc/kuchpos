import { FileSpreadsheet } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { PageHeader } from "@/components/page-header";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatDateTime, formatDay, nairaFromText, shopToday } from "@/lib/format";
import { IMPORT_TEMPLATE_PATH } from "@/lib/import-template";
import { requirePagePermission } from "@/server/auth/request";
import { importNumber, listImports } from "@/server/business/imports";
import { ImportForm } from "./import-form";

export const metadata: Metadata = { title: "Import from Excel — KuchPos" };

/** The day the shops' records in KuchPos begin (C66). Only the suggestion in the box; the admin can change it. */
const USUAL_STARTING_DAY = "2026-10-01";

export default async function ImportPage() {
  const context = await requirePagePermission("import.run");
  const imports = await listImports(context);
  const today = shopToday();

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        icon={FileSpreadsheet}
        title="Import from Excel"
        description={<>Bring this shop&apos;s records into KuchPos from one Excel file: products, customers and counted stock first, then the deliveries and sales since.</>}
      />

      <Card>
        <CardHeader>
          <CardTitle>1. Fill in the workbook</CardTitle>
          <CardDescription>
            Download the blank workbook, read its first sheet, and type the shop&apos;s own rows from row 4 down. One file for one shop.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <a href={IMPORT_TEMPLATE_PATH} download className="font-medium text-link underline-offset-4 hover:underline">
            Download the blank workbook (Excel)
          </a>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>2. Products, customers and stock</CardTitle>
          <CardDescription>
            The sheets Products, Customers and Stock are brought in here. All stock goes onto the Shelf; move part of it to the
            Storeroom afterwards with a transfer if you wish. Products and customers already in KuchPos are left as they are.
            Check the file first; nothing is saved until you bring it in.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ImportForm part="setup" today={today} defaultStartingDay={USUAL_STARTING_DAY <= today ? USUAL_STARTING_DAY : today} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>3. Deliveries and sales since the starting day</CardTitle>
          <CardDescription>
            Do this after step 2, with the same workbook: the sheets Deliveries and Sales are brought in, in the order things happened.
            Each sale keeps its own date and its own receipt number with IMP- in front, and goes through no till. A delivery or
            receipt that is already in KuchPos must be taken out of the file before it is used again.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ImportForm part="history" today={today} defaultStartingDay={USUAL_STARTING_DAY <= today ? USUAL_STARTING_DAY : today} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Files brought in so far</CardTitle>
        </CardHeader>
        <CardContent>
          {imports.length === 0 ? (
            <p className="rounded-3xl border border-dashed p-10 text-center text-sm text-muted-foreground">Nothing has been brought in yet.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Number</TableHead>
                  <TableHead>File</TableHead>
                  <TableHead>Records start</TableHead>
                  <TableHead>What came in</TableHead>
                  <TableHead>By</TableHead>
                  <TableHead>When</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {imports.map((run) => (
                  <TableRow key={run.id}>
                    <TableCell className="font-medium">{importNumber(run.number)}</TableCell>
                    <TableCell>{run.fileName}</TableCell>
                    <TableCell>{run.startingDay ? formatDay(run.startingDay) : "—"}</TableCell>
                    <TableCell>
                      {run.part === "HISTORY" ? (
                        <>
                          {run.summary.deliveries} {run.summary.deliveries === 1 ? "delivery" : "deliveries"}, {run.summary.sales} {run.summary.sales === 1 ? "sale" : "sales"}
                          {typeof run.summary.salesTotal === "string" ? ` (${nairaFromText(run.summary.salesTotal)})` : ""}
                        </>
                      ) : (
                        <>
                          {run.summary.products} products, {run.summary.customers} customers, {run.summary.stockLines} lines of stock
                          {typeof run.summary.stockValue === "string" ? ` (${nairaFromText(run.summary.stockValue)} at cost)` : ""}
                        </>
                      )}
                    </TableCell>
                    <TableCell>{run.byName}</TableCell>
                    <TableCell>{formatDateTime(run.at)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
          <p className="mt-4 text-sm text-muted-foreground">
            See what arrived: <Link href="/products" className="text-link hover:underline">Products</Link>,{" "}
            <Link href="/customers" className="text-link hover:underline">Customers</Link>,{" "}
            <Link href="/stock" className="text-link hover:underline">Stock</Link>,{" "}
            <Link href="/stock/receipts" className="text-link hover:underline">Deliveries</Link>,{" "}
            <Link href="/sales" className="text-link hover:underline">Sales</Link>.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
