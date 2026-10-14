/**
 * Which Storeroom batch should go first (C76) — shared by the server and the transfer and
 * adjustment screens, so the warning on screen and the note on the saved line always agree.
 */

export type BatchSummary = { id: string; batchNumber: string | null; expiryDate: string | null; receivedOn: string; quantity: string };

/**
 * The batch that should have been moved instead of this one: one that goes before it (earlier
 * expiry, or earlier arrival) and still has stock. Null when the chosen batch is the right one.
 * `batches` holds only batches with stock, the one that should go first on top.
 */
export function earlierBatchThan(batches: BatchSummary[], batchId: string): BatchSummary | null {
  const position = batches.findIndex((batch) => batch.id === batchId);
  if (position <= 0) return null;
  const chosen = batches[position];
  const first = batches[0];
  // Two batches with the same expiry date and day of arrival are as good as each other.
  return first.expiryDate === chosen.expiryDate && first.receivedOn === chosen.receivedOn ? null : first;
}

