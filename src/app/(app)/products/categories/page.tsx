import { ArrowLeft, Tags } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { ActionForm, SubmitButton, TextField } from "@/components/action-form";
import { PageHeader } from "@/components/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { requirePagePermission } from "@/server/auth/request";
import { listCategories } from "@/server/business/catalog";
import { createCategoryAction, removeCategoryAction, renameCategoryAction } from "../actions";

export const metadata: Metadata = { title: "Product categories — KuchPos" };

export default async function CategoriesPage() {
  const context = await requirePagePermission("product.manage");
  const categories = await listCategories(context);

  return (
    <div className="flex max-w-3xl flex-col gap-5">
      <Link href="/products" className="flex items-center gap-1 text-sm text-muted-foreground underline-offset-4 hover:underline">
        <ArrowLeft className="size-3.5" aria-hidden /> Products &amp; Categories
      </Link>
      <PageHeader
        icon={Tags}
        title="Product categories"
        description="Groups such as Seeds, Fertilizers or Feeds. They make products easier to find and filter."
      />

      <Card>
        <CardHeader>
          <CardTitle>Add a category</CardTitle>
        </CardHeader>
        <CardContent>
          <ActionForm action={createCategoryAction} resetOnSuccess>
            <div className="max-w-sm">
              <TextField name="name" label="Category name" autoComplete="off" required />
            </div>
            <SubmitButton pendingLabel="Adding…">Add category</SubmitButton>
          </ActionForm>
        </CardContent>
      </Card>

      {categories.length === 0 ? (
        <p className="rounded-3xl border border-dashed p-10 text-center text-sm text-muted-foreground">
          No categories yet.
        </p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Category</TableHead>
              <TableHead>Products in it</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {categories.map((category) => (
              <TableRow key={category.id} data-testid={`category-row-${category.name}`}>
                <TableCell>
                  <ActionForm action={renameCategoryAction} showSuccess={false} compact className="flex flex-wrap items-center gap-2">
                    <input type="hidden" name="categoryId" value={category.id} />
                    <Input
                      name="name"
                      defaultValue={category.name}
                      key={category.name}
                      aria-label={`Name of category ${category.name}`}
                      className="h-8 w-56"
                      required
                    />
                    <SubmitButton variant="outline" size="sm">
                      Rename
                    </SubmitButton>
                  </ActionForm>
                </TableCell>
                <TableCell>
                  <Link
                    href={`/products?category=${category.id}`}
                    className="text-link underline-offset-4 hover:underline"
                  >
                    {category.productCount}
                  </Link>
                </TableCell>
                <TableCell>
                  <ActionForm action={removeCategoryAction} showSuccess={false} compact>
                    <input type="hidden" name="categoryId" value={category.id} />
                    <SubmitButton variant="destructive" size="sm" disabled={category.productCount > 0}>
                      Remove
                    </SubmitButton>
                  </ActionForm>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      <p className="text-xs text-muted-foreground">
        A category can be removed only when no product is in it. To retire a category that is in use, move its
        products to another one first, or simply rename it.
      </p>
    </div>
  );
}
