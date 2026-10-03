import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ActionForm, CheckboxField, SelectField, SubmitButton, TextField } from "@/components/action-form";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatDateTime, nairaFromText, plainNumber } from "@/lib/format";
import { requirePagePermission } from "@/server/auth/request";
import { getProduct, listCategories } from "@/server/business/catalog";
import { NotFoundError, ValidationError } from "@/server/errors";
import { can } from "@/server/permissions";
import {
  addUnitAction,
  retireUnitAction,
  setProductActiveAction,
  setUnitPriceAction,
  setUnitUsageAction,
  updateProductAction,
} from "../actions";

export const metadata: Metadata = { title: "Product — KuchPos" };

export default async function ProductPage({ params }: PageProps<"/products/[productId]">) {
  const context = await requirePagePermission("price.view");
  const { productId } = await params;

  let data: Awaited<ReturnType<typeof getProduct>>;
  try {
    data = await getProduct(context, { productId });
  } catch (error) {
    // A product of another business, or a made-up address, looks exactly like one that does not exist.
    if (error instanceof NotFoundError || error instanceof ValidationError) notFound();
    throw error;
  }
  const { product, priceHistory } = data;
  const categories = await listCategories(context);
  const canManage = can(context, "product.manage");
  const canPrice = can(context, "price.manage");
  const base = product.baseUnitName;

  return (
    <div className="flex max-w-5xl flex-col gap-6">
      <div>
        <Link href="/products" className="text-sm text-muted-foreground underline-offset-4 hover:underline">
          ← Products &amp; Categories
        </Link>
        <h1 className="mt-1 flex flex-wrap items-center gap-2 text-2xl font-semibold tracking-tight">
          {product.name}
          {!product.active && <Badge variant="destructive">Out of use</Badge>}
        </h1>
        <p className="text-sm text-muted-foreground">
          {product.category ? `${product.category.name} · ` : ""}
          Stock is counted in <span className="font-medium text-foreground">{base}</span> ·{" "}
          {product.allowsFraction ? "sold by weight or volume" : "sold in whole units only"} ·{" "}
          {product.taxable ? "taxable" : "not taxable"}
        </p>
      </div>

      {canManage && (
        <Card id="details">
          <CardHeader>
            <CardTitle>Name and details</CardTitle>
            <CardDescription>
              The name, code, barcode, category and taxable tick can be changed whenever you like.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <ActionForm action={updateProductAction}>
              <input type="hidden" name="productId" value={product.id} />
              <div className="grid gap-x-4 gap-y-1 md:grid-cols-2">
                <TextField name="name" label="Product name" defaultValue={product.name} autoComplete="off" required />
                <SelectField
                  name="categoryId"
                  label="Category"
                  defaultValue={product.category?.id ?? ""}
                  key={product.category?.id ?? "none"}
                  options={[{ value: "", label: "No category" }, ...categories.map((c) => ({ value: c.id, label: c.name }))]}
                />
                <TextField name="code" label="Code (optional)" defaultValue={product.code ?? ""} autoComplete="off" />
                <TextField name="barcode" label="Barcode (optional)" defaultValue={product.barcode ?? ""} autoComplete="off" />
              </div>
              <CheckboxField name="taxable" label="Taxable" defaultChecked={product.taxable} />
              <SubmitButton className="mt-4">Save details</SubmitButton>
            </ActionForm>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Units and prices</CardTitle>
          <CardDescription>
            Each unit has its own price, tax included. A unit’s name and size never change: to change them, retire the
            unit and add a new one.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Unit</TableHead>
                <TableHead>Contains</TableHead>
                <TableHead>Selling price</TableHead>
                <TableHead>Used for</TableHead>
                {canManage && <TableHead />}
              </TableRow>
            </TableHeader>
            <TableBody>
              {product.units.map((unit) => (
                <TableRow key={unit.id} data-testid={`unit-row-${unit.name}${unit.retired ? "-retired" : ""}`}>
                  <TableCell className="font-medium">
                    {unit.name}
                    {unit.isBase && <Badge variant="secondary" className="ml-2">Base unit</Badge>}
                    {unit.retired && <Badge variant="outline" className="ml-2">Retired</Badge>}
                  </TableCell>
                  <TableCell>
                    {plainNumber(unit.factor)} {base}
                  </TableCell>
                  <TableCell>
                    {unit.retired || !unit.forSale || !canPrice ? (
                      unit.price && unit.forSale ? nairaFromText(unit.price) : <span className="text-muted-foreground">—</span>
                    ) : (
                      <ActionForm action={setUnitPriceAction} showSuccess={false} compact className="flex flex-wrap items-center gap-2">
                        <input type="hidden" name="unitId" value={unit.id} />
                        <span className="text-muted-foreground">₦</span>
                        <Input
                          name="price"
                          key={unit.price}
                          defaultValue={unit.price ?? ""}
                          inputMode="decimal"
                          autoComplete="off"
                          aria-label={`Price per ${unit.name}`}
                          className="h-8 w-32"
                          required
                        />
                        <SubmitButton variant="outline" size="sm">
                          Save price
                        </SubmitButton>
                      </ActionForm>
                    )}
                  </TableCell>
                  <TableCell>
                    {unit.retired || !canManage ? (
                      <span className="text-muted-foreground">
                        {[unit.forSale ? "selling" : null, unit.forPurchase ? "buying" : null].filter(Boolean).join(", ") || "—"}
                      </span>
                    ) : (
                      <ActionForm action={setUnitUsageAction} showSuccess={false} compact className="flex flex-wrap items-center gap-3">
                        <input type="hidden" name="unitId" value={unit.id} />
                        <label className="flex items-center gap-1.5 text-sm">
                          <input type="checkbox" name="forSale" defaultChecked={unit.forSale} className="size-4 accent-primary" />
                          Selling
                        </label>
                        <label className="flex items-center gap-1.5 text-sm">
                          <input type="checkbox" name="forPurchase" defaultChecked={unit.forPurchase} className="size-4 accent-primary" />
                          Buying
                        </label>
                        {unit.price === null && (
                          <Input name="price" placeholder="Price ₦" inputMode="decimal" aria-label={`First price per ${unit.name}`} className="h-8 w-24" />
                        )}
                        <SubmitButton variant="outline" size="sm">
                          Save
                        </SubmitButton>
                      </ActionForm>
                    )}
                  </TableCell>
                  {canManage && (
                    <TableCell>
                      {!unit.isBase && !unit.retired && (
                        <ActionForm action={retireUnitAction} showSuccess={false}>
                          <input type="hidden" name="unitId" value={unit.id} />
                          <SubmitButton variant="destructive" size="sm">
                            Retire
                          </SubmitButton>
                        </ActionForm>
                      )}
                    </TableCell>
                  )}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {canManage && product.active && (
        <Card>
          <CardHeader>
            <CardTitle>Add a unit</CardTitle>
            <CardDescription>
              For example a pack of 10 {base}, a carton of 100 {base}, or a bag of 50 {base}. Its price can include a
              bulk discount.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <ActionForm action={addUnitAction} resetOnSuccess>
              <input type="hidden" name="productId" value={product.id} />
              <div className="grid gap-x-4 gap-y-1 md:grid-cols-3">
                <TextField name="name" label="Unit name" hint="For example: pack, carton, bag" autoComplete="off" required />
                <TextField
                  name="factor"
                  label={`How many ${base} it contains`}
                  hint={product.allowsFraction ? "For example 50, or 0.25" : "A whole number, for example 10"}
                  inputMode="decimal"
                  autoComplete="off"
                  required
                />
                <TextField name="price" label="Selling price (₦)" hint="Tax included" inputMode="decimal" autoComplete="off" />
              </div>
              <div className="flex flex-wrap gap-6">
                <CheckboxField name="forSale" label="Used for selling" defaultChecked />
                <CheckboxField name="forPurchase" label="Used for buying" defaultChecked />
              </div>
              <SubmitButton pendingLabel="Adding…" className="mt-4">
                Add unit
              </SubmitButton>
            </ActionForm>
          </CardContent>
        </Card>
      )}

      {canManage && (
        <Card>
          <CardHeader>
            <CardTitle>{product.active ? "Stop selling this product" : "This product is out of use"}</CardTitle>
          </CardHeader>
          <CardContent>
            <div>
              <ActionForm action={setProductActiveAction} showSuccess={false}>
                <input type="hidden" name="productId" value={product.id} />
                <input type="hidden" name="active" value={product.active ? "false" : "true"} />
                <SubmitButton variant={product.active ? "destructive" : "outline"} size="sm">
                  {product.active ? "Take this product out of use" : "Bring this product back"}
                </SubmitButton>
              </ActionForm>
              <p className="mt-1 text-xs text-muted-foreground">
                Products are never deleted. One that is out of use is hidden from the list and cannot be sold.
              </p>
            </div>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Price history</CardTitle>
          <CardDescription>Every price change for this product, newest first. It cannot be edited.</CardDescription>
        </CardHeader>
        <CardContent>
          {priceHistory.length === 0 ? (
            <p className="text-sm text-muted-foreground">No prices have been set yet.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>When</TableHead>
                  <TableHead>Unit</TableHead>
                  <TableHead>Old price</TableHead>
                  <TableHead>New price</TableHead>
                  <TableHead>Changed by</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {priceHistory.map((entry) => (
                  <TableRow key={entry.id} data-testid="price-history-row">
                    <TableCell className="whitespace-nowrap text-muted-foreground">{formatDateTime(entry.createdAt)}</TableCell>
                    <TableCell>{entry.unitName}</TableCell>
                    <TableCell>{entry.oldPrice ? nairaFromText(entry.oldPrice) : "—"}</TableCell>
                    <TableCell className="font-medium">{entry.newPrice ? nairaFromText(entry.newPrice) : "—"}</TableCell>
                    <TableCell>{entry.changedByName}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
