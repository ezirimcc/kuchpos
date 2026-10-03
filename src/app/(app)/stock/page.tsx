import { Warehouse } from "lucide-react";
import type { Metadata } from "next";
import { Suspense } from "react";
import { FilterSelect, FilterToggle, LiveSearch } from "@/components/filters";
import { PageHeader } from "@/components/page-header";
import { Pagination } from "@/components/pagination";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { breakIntoUnits, plainNumber } from "@/lib/format";
import { requirePagePermission } from "@/server/auth/request";
import { listCategories } from "@/server/business/catalog";
import { listStockOnHand } from "@/server/business/stock";
import { StockTabs } from "./stock-tabs";

export const metadata: Metadata = { title: "Stock on hand — KuchPos" };

function text(value: string | string[] | undefined): string {
  return typeof value === "string" ? value : "";
}

export default async function StockPage({ searchParams }: PageProps<"/stock">) {
  const context = await requirePagePermission("stock.view");
  const params = await searchParams;
  const filters = { q: text(params.q), category: text(params.category), instock: text(params.instock) };
  const [list, categories] = await Promise.all([
    listStockOnHand(context, { search: filters.q, category: filters.category, inStock: filters.instock, page: text(params.page) }),
    listCategories(context),
  ]);
  const filtered = Object.values(filters).some((value) => value !== "");

  return (
    <div className="flex flex-col gap-5">
      <PageHeader icon={Warehouse} title="Stock" description="How much of each product is in each place, counted in its base unit." />
      <StockTabs context={context} current="on-hand" />

      <Suspense>
        <div className="flex flex-wrap items-center gap-3">
          <LiveSearch label="Search stock" placeholder="Search by name, code or barcode" autoFocus />
          <FilterSelect
            name="category"
            label="Filter by category"
            allLabel="All categories"
            options={[...categories.map((category) => ({ value: category.id, label: category.name })), { value: "none", label: "No category" }]}
          />
          <FilterToggle name="instock" label="Only products in stock" />
        </div>
      </Suspense>

      {list.rows.length === 0 ? (
        <p className="rounded-3xl border border-dashed p-10 text-center text-sm text-muted-foreground">
          {filtered ? "No product matches. Try a different search or filter." : "No products yet."}
        </p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Product</TableHead>
              <TableHead>Category</TableHead>
              {list.locations.map((location) => (
                <TableHead key={location.id} className="text-right">
                  {location.name}
                </TableHead>
              ))}
              <TableHead className="text-right">Total</TableHead>
              <TableHead>In larger units</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {list.rows.map((row) => {
              const empty = plainNumber(row.total) === "0";
              return (
                <TableRow key={row.productId} data-testid={`stock-row-${row.productName}`}>
                  <TableCell className="font-medium">
                    {row.productName}
                    {row.code && <span className="ml-2 text-xs font-normal text-muted-foreground">{row.code}</span>}
                  </TableCell>
                  <TableCell>{row.category ? <Badge variant="secondary">{row.category}</Badge> : <span className="text-muted-foreground">—</span>}</TableCell>
                  {list.locations.map((location) => (
                    <TableCell key={location.id} className="text-right tabular-nums" data-testid={`stock-${location.name}`}>
                      {plainNumber(row.byLocation[location.id] ?? "0")}
                    </TableCell>
                  ))}
                  <TableCell className="text-right font-semibold tabular-nums" data-testid="stock-total">
                    {plainNumber(row.total)} <span className="font-normal text-muted-foreground">{row.baseUnitName}</span>
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {empty ? <Badge variant="outline">None</Badge> : breakIntoUnits(row.total, row.baseUnitName, row.units)}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      )}

      <Pagination path="/stock" params={filters} noun="products" {...list} />
    </div>
  );
}
