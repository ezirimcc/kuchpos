import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatDay, plainNumber } from "@/lib/format";
import type { AppContext } from "@/server/auth/context";
import { getProductBatches } from "@/server/business/stock";

/**
 * The Storeroom's batches of a product that has batch numbers or expiry dates (C76): what is
 * left of each, the one that should go first on top. The Shelf is not counted by batch.
 * Nothing is drawn for other products.
 */
export async function ProductBatches({ context, productId }: { context: AppContext; productId: string }) {
  const data = await getProductBatches(context, { productId });
  if (!data.tracked) return null;

  return (
    <Card id="batches" data-testid="product-batches-card">
      <CardHeader>
        <CardTitle>Batches in the {data.storeroom?.name ?? "Storeroom"}</CardTitle>
        <CardDescription>
          What is left of each batch, the one that should be moved first on top: the earliest expiry date, and where there is none, the one that came in
          first. Every delivery, transfer and adjustment in the {data.storeroom?.name ?? "Storeroom"} names its batch, so these figures are exact. On the
          Shelf: {plainNumber(data.onShelf)} {data.baseUnitName}, not counted by batch.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {data.batches.length === 0 ? (
          <p className="rounded-3xl border border-dashed p-10 text-center text-sm text-muted-foreground">None of this product is in the {data.storeroom?.name ?? "Storeroom"}.</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Batch</TableHead>
                <TableHead>Expires</TableHead>
                <TableHead>First came in</TableHead>
                <TableHead className="text-right">Left</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.batches.map((batch, index) => (
                <TableRow key={batch.id} data-testid="batch-row" className={batch.soon ? "bg-destructive/10 hover:bg-destructive/15" : undefined}>
                  <TableCell className="font-medium">
                    {data.canOpenHistory ? (
                      <Link href={`/stock/batches/${batch.id}`} className="text-link underline-offset-4 hover:underline" title="See everything that happened to this batch">
                        {batch.batchNumber ?? "No batch number"}
                      </Link>
                    ) : (
                      (batch.batchNumber ?? <span className="font-normal text-muted-foreground">No batch number</span>)
                    )}
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
                  <TableCell className="text-right font-semibold tabular-nums">
                    {plainNumber(batch.quantity)} <span className="font-normal text-muted-foreground">{data.baseUnitName}</span>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
        <p className="text-xs text-muted-foreground">
          Rows in red expire soon or have expired.{data.canOpenHistory && " Open a batch to see everything that happened to it."}
        </p>
        {data.finished.length > 0 && (
          // Used up in the Storeroom: offered nowhere any more, but kept for the record (C78).
          <details className="rounded-2xl border px-4 py-3 text-sm" data-testid="finished-batches">
            <summary className="cursor-pointer font-medium">Finished batches ({data.finished.length})</summary>
            <ul className="mt-3 flex flex-col gap-1.5">
              {data.finished.map((batch) => (
                <li key={batch.id} data-testid="finished-batch">
                  {data.canOpenHistory ? (
                    <Link href={`/stock/batches/${batch.id}`} className="text-link underline-offset-4 hover:underline">
                      {batch.batchNumber ?? "No batch number"}
                    </Link>
                  ) : (
                    (batch.batchNumber ?? "No batch number")
                  )}
                  <span className="text-muted-foreground">
                    {batch.expiryDate ? ` · expires ${formatDay(batch.expiryDate)}` : ""} · first came in {formatDay(batch.receivedOn)}
                  </span>
                </li>
              ))}
            </ul>
          </details>
        )}
      </CardContent>
    </Card>
  );
}
