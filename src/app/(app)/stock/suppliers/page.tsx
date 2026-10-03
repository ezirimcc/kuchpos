import { Truck } from "lucide-react";
import type { Metadata } from "next";
import { ActionForm, SubmitButton, TextField } from "@/components/action-form";
import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { requirePagePermission } from "@/server/auth/request";
import { listSuppliers } from "@/server/business/suppliers";
import { can } from "@/server/permissions";
import { createSupplierAction, setSupplierActiveAction, updateSupplierAction } from "../actions";
import { StockTabs } from "../stock-tabs";

export const metadata: Metadata = { title: "Suppliers — KuchPos" };

export default async function SuppliersPage() {
  const context = await requirePagePermission("stock.receipts.view");
  const suppliers = await listSuppliers(context);
  const canManage = can(context, "supplier.manage");

  return (
    <div className="flex flex-col gap-5">
      <PageHeader icon={Truck} title="Suppliers" description="The companies and people you buy goods from." />
      <StockTabs context={context} current="suppliers" />

      {canManage && (
        <Card>
          <CardHeader>
            <CardTitle>Add a supplier</CardTitle>
          </CardHeader>
          <CardContent>
            <ActionForm action={createSupplierAction} resetOnSuccess>
              <div className="grid gap-x-4 gap-y-1 md:grid-cols-3">
                <TextField name="name" label="Supplier's name" autoComplete="off" required />
                <TextField name="phone" label="Phone (optional)" autoComplete="off" />
                <TextField name="note" label="Note (optional)" autoComplete="off" />
              </div>
              <SubmitButton pendingLabel="Adding…">Add supplier</SubmitButton>
            </ActionForm>
          </CardContent>
        </Card>
      )}

      {suppliers.length === 0 ? (
        <p className="rounded-3xl border border-dashed p-10 text-center text-sm text-muted-foreground">No suppliers yet.</p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Supplier</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="text-right">Deliveries</TableHead>
              {canManage && <TableHead />}
            </TableRow>
          </TableHeader>
          <TableBody>
            {suppliers.map((supplier) => (
              <TableRow key={supplier.id} data-testid={`supplier-row-${supplier.name}`}>
                <TableCell>
                  {canManage ? (
                    <ActionForm action={updateSupplierAction} showSuccess={false} compact className="flex flex-wrap items-center gap-2">
                      <input type="hidden" name="supplierId" value={supplier.id} />
                      <Input name="name" defaultValue={supplier.name} key={supplier.name} aria-label={`Name of ${supplier.name}`} className="h-9 w-56" required />
                      <Input name="phone" defaultValue={supplier.phone ?? ""} placeholder="Phone" aria-label={`Phone of ${supplier.name}`} className="h-9 w-40" />
                      <Input name="note" defaultValue={supplier.note ?? ""} placeholder="Note" aria-label={`Note about ${supplier.name}`} className="h-9 w-56" />
                      <SubmitButton variant="outline" size="sm">
                        Save
                      </SubmitButton>
                    </ActionForm>
                  ) : (
                    <span className="font-medium">
                      {supplier.name}
                      {supplier.phone && <span className="ml-2 font-normal text-muted-foreground">{supplier.phone}</span>}
                    </span>
                  )}
                </TableCell>
                <TableCell>
                  {supplier.active ? <Badge variant="success">In use</Badge> : <Badge variant="destructive">Out of use</Badge>}
                </TableCell>
                <TableCell className="text-right tabular-nums">{supplier.deliveries}</TableCell>
                {canManage && (
                  <TableCell>
                    <ActionForm action={setSupplierActiveAction} showSuccess={false} compact>
                      <input type="hidden" name="supplierId" value={supplier.id} />
                      <input type="hidden" name="active" value={supplier.active ? "false" : "true"} />
                      <SubmitButton variant={supplier.active ? "destructive" : "outline"} size="sm">
                        {supplier.active ? "Take out of use" : "Bring back"}
                      </SubmitButton>
                    </ActionForm>
                  </TableCell>
                )}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  );
}
