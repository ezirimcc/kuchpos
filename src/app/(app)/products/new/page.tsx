import type { Metadata } from "next";
import Link from "next/link";
import { ActionForm, CheckboxField, SelectField, SubmitButton, TextField } from "@/components/action-form";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { requirePagePermission } from "@/server/auth/request";
import { listCategories } from "@/server/business/catalog";
import { createProductAction } from "../actions";

export const metadata: Metadata = { title: "Add a product — KuchPos" };

export default async function NewProductPage() {
  const context = await requirePagePermission("product.manage");
  const categories = await listCategories(context);

  return (
    <div className="flex max-w-3xl flex-col gap-5">
      <div>
        <Link href="/products" className="text-sm text-muted-foreground underline-offset-4 hover:underline">
          ← Products &amp; prices
        </Link>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight">Add a product</h1>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>The product and its base unit</CardTitle>
          <CardDescription>
            The base unit is the smallest unit you count stock in — for example “single”, “sachet”, “kg” or “litre”.
            Bigger units such as pack, carton or bag are added on the next screen. The base unit and how the product
            is sold cannot be changed later. The name, code, category and prices can be changed at any time.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ActionForm action={createProductAction}>
            <div className="grid gap-x-4 gap-y-1 md:grid-cols-2">
              <TextField name="name" label="Product name" autoComplete="off" required />
              <SelectField
                name="categoryId"
                label="Category (optional)"
                defaultValue=""
                options={[{ value: "", label: "No category" }, ...categories.map((c) => ({ value: c.id, label: c.name }))]}
              />
              <TextField name="code" label="Code (optional)" hint="Your own short code for this product" autoComplete="off" />
              <TextField name="baseUnitName" label="Base unit" hint="For example: single, sachet, kg, litre" autoComplete="off" required />
              <SelectField
                name="soldBy"
                label="Sold in"
                defaultValue="whole"
                options={[
                  { value: "whole", label: "Whole units only (1, 2, 3…)" },
                  { value: "measure", label: "Weight or volume (2.5 kg, 0.75 litre…)" },
                ]}
              />
              <TextField
                name="basePrice"
                label="Selling price of one base unit (₦)"
                hint="Tax included. For example 500 or 1250.50"
                inputMode="decimal"
                autoComplete="off"
              />
              <TextField name="barcode" label="Barcode (optional)" hint="Leave empty if the product has none" autoComplete="off" />
            </div>
            <div className="mt-1 flex flex-col gap-2">
              <CheckboxField
                name="baseForSale"
                label="The base unit is sold on its own"
                hint="Untick if you only ever sell this product in bigger units."
                defaultChecked
              />
              <CheckboxField name="taxable" label="Taxable" hint="Untick for products that carry no tax." defaultChecked />
            </div>
            <SubmitButton pendingLabel="Creating…" className="mt-4">
              Create product
            </SubmitButton>
          </ActionForm>
        </CardContent>
      </Card>
    </div>
  );
}
