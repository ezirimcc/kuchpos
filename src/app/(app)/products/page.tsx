import { Package, Plus, Tags } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { FilterSelect, FilterToggle, LiveSearch } from "@/components/filters";
import { PageHeader } from "@/components/page-header";
import { Pagination } from "@/components/pagination";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { nairaFromText, plainNumber } from "@/lib/format";
import { requirePagePermission } from "@/server/auth/request";
import { listCategories, listProducts } from "@/server/business/catalog";
import { can } from "@/server/permissions";

export const metadata: Metadata = { title: "Products & prices — KuchPos" };

function text(value: string | string[] | undefined): string {
  return typeof value === "string" ? value : "";
}

export default async function ProductsPage({ searchParams }: PageProps<"/products">) {
  const context = await requirePagePermission("price.view");
  const params = await searchParams;
  const filters = { q: text(params.q), category: text(params.category), all: text(params.all) };
  const canManage = can(context, "product.manage");

  const [list, categories] = await Promise.all([
    listProducts(context, {
      search: filters.q,
      category: filters.category,
      includeInactive: filters.all === "1" && canManage,
      page: text(params.page),
    }),
    listCategories(context),
  ]);
  const filtered = filters.q !== "" || filters.category !== "";

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        icon={Package}
        title="Products & prices"
        description="Every unit a product is sold in, with its own price. Prices include tax."
      >
        {canManage && (
          <>
            <Link href="/products/categories" className={buttonVariants({ variant: "outline" })}>
              <Tags className="size-4" aria-hidden /> Categories
            </Link>
            <Link href="/products/new" className={buttonVariants()}>
              <Plus className="size-4" aria-hidden /> Add a product
            </Link>
          </>
        )}
      </PageHeader>

      <Suspense>
        <div className="flex flex-wrap items-center gap-3">
          <LiveSearch label="Search products" placeholder="Search by name, code or barcode" autoFocus />
          <FilterSelect
            name="category"
            label="Filter by category"
            allLabel="All categories"
            options={[
              ...categories.map((category) => ({ value: category.id, label: category.name })),
              { value: "none", label: "No category" },
            ]}
          />
          {canManage && <FilterToggle name="all" label="Include products taken out of use" />}
        </div>
      </Suspense>

      {list.products.length === 0 ? (
        <p className="rounded-xl border border-dashed bg-card p-8 text-center text-sm text-muted-foreground">
          {filtered ? "No product matches. Try a different search or category." : "No products yet."}
        </p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Product</TableHead>
              <TableHead>Category</TableHead>
              <TableHead>Code</TableHead>
              <TableHead>Units and prices</TableHead>
              <TableHead>Tax</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {list.products.map((product) => (
              <TableRow key={product.id} data-testid={`product-row-${product.name}`}>
                <TableCell className="font-medium">
                  <Link href={`/products/${product.id}`} className="text-primary underline-offset-4 hover:underline">
                    {product.name}
                  </Link>
                  {!product.active && (
                    <Badge variant="destructive" className="ml-2">
                      Out of use
                    </Badge>
                  )}
                </TableCell>
                <TableCell>
                  {product.category ? (
                    <Badge variant="secondary">{product.category.name}</Badge>
                  ) : (
                    <span className="text-muted-foreground">—</span>
                  )}
                </TableCell>
                <TableCell className="text-muted-foreground">{product.code ?? "—"}</TableCell>
                <TableCell>
                  <ul className="flex flex-col gap-0.5">
                    {product.units.map((unit) => (
                      <li key={unit.id}>
                        <span className="font-medium">{unit.name}</span>
                        {!unit.isBase && (
                          <span className="text-muted-foreground">
                            {" "}
                            ({plainNumber(unit.factor)} {product.baseUnitName})
                          </span>
                        )}
                        {" — "}
                        {unit.price && unit.forSale ? (
                          nairaFromText(unit.price)
                        ) : (
                          <span className="text-muted-foreground">not for sale</span>
                        )}
                      </li>
                    ))}
                  </ul>
                </TableCell>
                <TableCell className="text-muted-foreground">{product.taxable ? "Taxable" : "Not taxable"}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}

      <Pagination path="/products" params={filters} noun="products" {...list} />
    </div>
  );
}
