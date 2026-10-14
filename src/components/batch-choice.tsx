"use client";

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { type BatchSummary, earlierBatchThan } from "@/lib/batch-order";
import { formatDay, plainNumber } from "@/lib/format";

/** The value of the "batch" box meaning: a batch not on record yet (going into the Storeroom). */
export const NEW_BATCH = "new";

export type BatchProduct = {
  baseUnitName: string;
  tracksBatch: boolean;
  tracksExpiry: boolean;
  storeroomBatches: BatchSummary[];
  knownBatches: { id: string; batchNumber: string | null; expiryDate: string | null }[];
};

/** A batch as people read it: "LH-7 · expires 31 Mar 2027". */
export function batchText(batch: { batchNumber: string | null; expiryDate: string | null }): string {
  return [batch.batchNumber ?? "No batch number", batch.expiryDate ? `expires ${formatDay(batch.expiryDate)}` : null].filter(Boolean).join(" · ");
}

/**
 * Which Storeroom batch a line moves (C76), on the transfer and adjustment screens.
 * Taking out: one of the batches the Storeroom holds, the one that should go first offered
 * first — with `warnEarlier`, a warning when a later one is chosen. Putting in: a batch the
 * product has had before, or a new batch number / expiry date.
 */
export function BatchChoice({
  lineKey,
  index,
  value,
  product,
  taking,
  label,
  storeroomName,
  warnEarlier = false,
  errors,
  onChange,
}: {
  lineKey: string;
  index: number;
  value: { batchId: string; batchNumber: string; expiryDate: string };
  product: BatchProduct;
  taking: boolean;
  label: string;
  storeroomName: string;
  warnEarlier?: boolean;
  errors: Record<string, string>;
  onChange: (patch: { batchId?: string; batchNumber?: string; expiryDate?: string }) => void;
}) {
  const problem = (name: string) => (errors[name] ? <p className="text-xs text-destructive">{errors[name]}</p> : null);
  const id = `batch-${lineKey}`;

  if (taking) {
    const chosen = product.storeroomBatches.find((batch) => batch.id === value.batchId);
    const earlier = warnEarlier && chosen ? earlierBatchThan(product.storeroomBatches, chosen.id) : null;
    return (
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={id}>{label}</Label>
        <NativeSelect id={id} value={value.batchId} onChange={(event) => onChange({ batchId: event.target.value })} aria-invalid={!!errors[`lines.${index}.batchId`]} required>
          {product.storeroomBatches.length === 0 && <option value="">No batch of this product is in the {storeroomName}</option>}
          {product.storeroomBatches.map((batch, position) => (
            <option key={batch.id} value={batch.id}>
              {batchText(batch)} · {plainNumber(batch.quantity)} {product.baseUnitName} left{position === 0 ? " · should go first" : ""}
            </option>
          ))}
        </NativeSelect>
        {problem(`lines.${index}.batchId`)}
        {earlier && (
          <p role="alert" data-testid={`earlier-batch-${index + 1}`} className="rounded-2xl border border-amber-500/40 bg-amber-500/10 px-4 py-2.5 text-sm text-amber-900 dark:text-amber-200">
            Batch {batchText(earlier)} is still in the {storeroomName} and should be moved first ({plainNumber(earlier.quantity)} {product.baseUnitName} left). You can still move this batch; the transfer will
            record that an earlier batch was passed over.
          </p>
        )}
      </div>
    );
  }

  return (
    <div className="grid gap-3 md:grid-cols-11">
      <div className="flex flex-col gap-1.5 md:col-span-5">
        <Label htmlFor={id}>{label}</Label>
        <NativeSelect id={id} value={value.batchId} onChange={(event) => onChange({ batchId: event.target.value })} aria-invalid={!!errors[`lines.${index}.batchId`]} required>
          <option value="">Choose the batch…</option>
          {product.knownBatches.map((batch) => (
            <option key={batch.id} value={batch.id}>
              {batchText(batch)}
            </option>
          ))}
          <option value={NEW_BATCH}>A batch not listed here</option>
        </NativeSelect>
        {problem(`lines.${index}.batchId`)}
      </div>
      {value.batchId === NEW_BATCH && product.tracksBatch && (
        <div className="flex flex-col gap-1.5 md:col-span-3">
          <Label htmlFor={`batch-number-${lineKey}`}>Batch number</Label>
          <Input id={`batch-number-${lineKey}`} value={value.batchNumber} onChange={(event) => onChange({ batchNumber: event.target.value })} maxLength={60} autoComplete="off" required />
        </div>
      )}
      {value.batchId === NEW_BATCH && product.tracksExpiry && (
        <div className="flex flex-col gap-1.5 md:col-span-3">
          <Label htmlFor={`expiry-${lineKey}`}>Expiry date</Label>
          <Input id={`expiry-${lineKey}`} type="date" value={value.expiryDate} onChange={(event) => onChange({ expiryDate: event.target.value })} aria-invalid={!!errors[`lines.${index}.expiryDate`]} required />
          {problem(`lines.${index}.expiryDate`)}
        </div>
      )}
    </div>
  );
}
