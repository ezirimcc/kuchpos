import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatDay, plainNumber } from "@/lib/format";
import type { AppContext } from "@/server/auth/context";
import { getProductBatches } from "@/server/business/stock";

/**
 * The batches of a product that has batch numbers or expiry dates (C73): what is left of each
 * and where, the one that should go first on top. Nothing is drawn for other products.
 */
export async function ProductBatches({ context, productId }: { context: AppContext; productId: string }) {
  const data = await getProductBatches(context, { productId });
  if (!data.tracked) return null;

  return (
    <Card id="batches" data-testid="product-batches-card">
      <CardHeader>
        <CardTitle>Batches in stock</CardTitle>
        <CardDescription>
          What is left of each batch, the one that should be sold or moved first on top: the earliest expiry date, and where there is none, the one that
          came in first.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {data.batches.length === 0 ? (
          <p className="rounded-3xl border border-dashed p-10 text-center text-sm text-muted-foreground">None of this product is in stock.</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Batch</TableHead>
                <TableHead>Expires</TableHead>
                <TableHead>First came in</TableHead>
                {data.locations.map((location) => (
                  <TableHead key={location.id} className="text-right">
                    {location.name}
                  </TableHead>
                ))}
                <TableHead className="text-right">In all</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.batches.map((batch, index) => (
                <TableRow key={batch.id} data-testid="batch-row" className={batch.soon ? "bg-destructive/10 hover:bg-destructive/15" : undefined}>
                  <TableCell className="font-medium">
                    {batch.batchNumber ?? <span className="font-normal text-muted-foreground">No batch number</span>}
                    {index === 0 && data.batches.length > 1 && (
                      <Badge variant="success" className="ml-2" data-testid="batch-first">
                        Goes first
                      </Badge>
                    )}
                  </TableCell>
                  <TableCell className={batch.soon ? "whitespace-nowrap text-destructive" : "whitespace-nowrap"}>
                    {batch.expiryDate ? formatDay(batch.expiryDate) : <span className="text-muted-foreground">—</span>}
                    {batch.expired && (
                      <Badge variant="destructive" className="ml-2">
                        Expired
                      </Badge>
                    )}
                  </TableCell>
                  <TableCell className="whitespace-nowrap">{formatDay(batch.receivedOn)}</TableCell>
                  {data.locations.map((location) => (
                    <TableCell key={location.id} className="text-right tabular-nums">
                      {plainNumber(batch.byLocation[location.id] ?? "0")}
                    </TableCell>
                  ))}
                  <TableCell className="text-right font-semibold tabular-nums">
                    {plainNumber(batch.total)} <span className="font-normal text-muted-foreground">{data.baseUnitName}</span>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
        <p className="text-xs text-muted-foreground">
          How much is left of each batch is worked out on the rule that what goes first was sold first. Which batch is on the Shelf and which in the Storeroom
          is an estimate for now — the batch that goes first is taken to be on the Shelf — until transfers are recorded batch by batch. Rows in red expire soon
          or have expired.
        </p>
      </CardContent>
    </Card>
  );
}
