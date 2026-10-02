import type { Metadata } from "next";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { nairaFromText, plainNumber } from "@/lib/format";
import { requirePagePermission } from "@/server/auth/request";
import { listProducts } from "@/server/business/catalog";
import { can } from "@/server/permissions";

export const metadata: Metadata = { title: "Products & prices — KuchPos" };

export default async function ProductsPage({ searchParams }: PageProps<"/products">) {
  const context = await requirePagePermission("price.view");
  const params = await searchParams;
  const search = typeof params.q === "string" ? params.q : "";
  const showInactive = params.all === "1";
  const canManage = can(context, "product.manage");

  const { products, limited } = await listProducts(context, { search, includeInactive: showInactive && canManage });

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Products &amp; prices</h1>
          <p className="text-sm text-muted-foreground">
            Every unit a product is sold in, with its own price. Prices include tax.
          </p>
        </div>
        {canManage && (
          <Link href="/products/new" className={buttonVariants()}>
            Add a product
          </Link>
        )}
      </div>

      <form method="get" className="flex flex-wrap items-center gap-2">
        <Input
          name="q"
          defaultValue={search}
          placeholder="Search by name, code or barcode"
          aria-label="Search products"
          className="w-80"
          autoFocus
        />
        {canManage && (
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" name="all" value="1" defaultChecked={showInactive} className="size-4 accent-primary" />
            Include products taken out of use
          </label>
        )}
        <button type="submit" className={buttonVariants({ variant: "outline" })}>
          Search
        </button>
      </form>

      {products.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          {search ? "No product matches that search." : "No products yet."}
        </p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Product</TableHead>
              <TableHead>Code</TableHead>
              <TableHead>Units and prices</TableHead>
              <TableHead>Tax</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {products.map((product) => (
              <TableRow key={product.id} data-testid={`product-row-${product.name}`}>
                <TableCell className="font-medium">
                  <Link href={`/products/${product.id}`} className="underline-offset-4 hover:underline">
                    {product.name}
                  </Link>
                  {!product.active && (
                    <Badge variant="destructive" className="ml-2">
                      Out of use
                    </Badge>
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
                        {unit.price ? nairaFromText(unit.price) : <span className="text-muted-foreground">not for sale</span>}
                      </li>
                    ))}
                  </ul>
                </TableCell>
                <TableCell>{product.taxable ? "Taxable" : "Not taxable"}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      {limited && (
        <p className="text-sm text-muted-foreground">Only the first 200 products are shown. Search to narrow the list.</p>
      )}
    </div>
  );
}
