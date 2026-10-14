"use client";

import { Plus, Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useMemo, useState, useTransition } from "react";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { BatchChoice, NEW_BATCH } from "@/components/batch-choice";
import { ADJUSTMENT_REASONS } from "@/lib/adjustment-reasons";
import { breakIntoUnits, plainNumber } from "@/lib/format";
import type { AdjustmentOptions, AdjustmentProduct } from "@/server/business/adjustments";
import { recordAdjustmentAction } from "../../actions";

/** `batchId`: a Storeroom batch on record; "new" = stock added to a batch not on record yet (C76). */
type Line = { key: string; productName: string; direction: "remove" | "add"; unitId: string; quantity: string; reason: string; batchId: string; batchNumber: string; expiryDate: string };

// The first line has a fixed key so the page the server sends matches what the browser draws;
// lines added later get a random one.
const newLine = (key: string = crypto.randomUUID()): Line => ({ key, productName: "", direction: "remove", unitId: "", quantity: "", reason: "", batchId: "", batchNumber: "", expiryDate: "" });

export function AdjustmentForm({ options }: { options: AdjustmentOptions }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  // Made up once per adjustment, so pressing Save twice can never record it twice.
  const [requestId, setRequestId] = useState(() => crypto.randomUUID());
  const [locationId, setLocationId] = useState("");
  const [note, setNote] = useState("");
  const [lines, setLines] = useState<Line[]>(() => [newLine("first")]);
  const [message, setMessage] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});

  const productByName = useMemo(
    () => new Map(options.products.map((product) => [product.name.toLowerCase(), product])),
    [options.products],
  );
  const find = (name: string): AdjustmentProduct | undefined => productByName.get(name.trim().toLowerCase());
  const locationName = options.locations.find((location) => location.id === locationId)?.name ?? "";
  // In the Storeroom, a product with batches names the batch it changes (C76).
  const inStoreroom = options.locations.find((location) => location.id === locationId)?.kind === "STOREROOM";
  const batched = (product: AdjustmentProduct | undefined) => !!product && (product.tracksBatch || product.tracksExpiry) && inStoreroom;
  // Taking out, the batch that should go first is offered first; adding, nothing is chosen for the person.
  const startBatch = (product: AdjustmentProduct | undefined, direction: Line["direction"]) => (product && direction === "remove" ? (product.storeroomBatches[0]?.id ?? "") : "");

  function change(key: string, patch: Partial<Line>) {
    setLines((current) => current.map((line) => (line.key === key ? { ...line, ...patch } : line)));
  }

  function chooseProduct(key: string, productName: string) {
    const product = find(productName);
    // Default to the smallest unit: damage and loss are usually a few singles, not cartons.
    const direction = lines.find((line) => line.key === key)?.direction ?? "remove";
    change(key, { productName, unitId: product ? (product.units[0]?.id ?? "") : "", batchId: startBatch(product, direction), batchNumber: "", expiryDate: "" });
  }

  function chooseLocation(id: string) {
    setLocationId(id);
    // A batch chosen for one place means nothing in another: start again.
    const storeroom = options.locations.find((location) => location.id === id)?.kind === "STOREROOM";
    setLines((current) => current.map((line) => ({ ...line, batchId: storeroom ? startBatch(find(line.productName), line.direction) : "", batchNumber: "", expiryDate: "" })));
  }

  function chooseDirection(key: string, direction: Line["direction"]) {
    const product = find(lines.find((line) => line.key === key)?.productName ?? "");
    change(key, { direction, batchId: startBatch(product, direction), batchNumber: "", expiryDate: "" });
  }

  function save(event: React.FormEvent) {
    event.preventDefault();
    if (pending) return;
    setMessage(null);
    setErrors({});
    startTransition(async () => {
      const result = await recordAdjustmentAction({
        requestId,
        locationId,
        note,
        lines: lines.map((line) => ({
          productId: find(line.productName)?.id ?? "",
          unitId: line.unitId,
          direction: line.direction,
          quantity: line.quantity,
          reason: line.reason,
          ...(batched(find(line.productName))
            ? line.batchId === NEW_BATCH
              ? { batchId: "", batchNumber: line.batchNumber, expiryDate: line.expiryDate }
              : { batchId: line.batchId, batchNumber: "", expiryDate: "" }
            : {}),
        })),
      });
      if (result.status === "success" && result.adjustmentId) {
        setRequestId(crypto.randomUUID());
        router.push(`/stock/adjustments/${result.adjustmentId}`);
      } else if (result.status === "error") {
        setMessage(result.message);
        setErrors(result.fieldErrors);
      }
    });
  }

  const problem = (name: string) => (errors[name] ? <p className="text-xs text-destructive">{errors[name]}</p> : null);

  if (options.products.length === 0) {
    return (
      <p className="rounded-3xl border border-dashed p-10 text-center text-sm text-muted-foreground">
        There are no products yet. Add products under Products &amp; Categories first.
      </p>
    );
  }

  return (
    <form onSubmit={save} className="flex flex-col gap-4">
      <datalist id="adjustment-products">
        {options.products.map((product) => (
          <option key={product.id} value={product.name}>
            {product.code ?? ""}
          </option>
        ))}
      </datalist>

      <Card>
        <CardContent>
          <div className="flex max-w-xs flex-col gap-1.5">
            <Label htmlFor="location">Which location?</Label>
            <NativeSelect id="location" value={locationId} onChange={(event) => chooseLocation(event.target.value)} aria-invalid={!!errors.locationId} required>
              <option value="">Choose a location…</option>
              {options.locations.map((location) => (
                <option key={location.id} value={location.id}>
                  {location.name}
                </option>
              ))}
            </NativeSelect>
            {problem("locationId")}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="flex flex-col gap-4">
          {lines.map((line, index) => {
            const product = find(line.productName);
            // Taking out of a chosen Storeroom batch: what that batch holds (C76).
            const chosenBatch = product && batched(product) && line.direction === "remove" ? product.storeroomBatches.find((batch) => batch.id === line.batchId) : undefined;
            const available = product && locationId ? (chosenBatch?.quantity ?? product.stock[locationId] ?? "0") : null;
            return (
              <div key={line.key} data-testid={`adjustment-line-${index + 1}`} className="grid gap-3 border-b pb-4 last:border-0 last:pb-0 md:grid-cols-12">
                <div className="flex flex-col gap-1.5 md:col-span-4">
                  <Label htmlFor={`product-${line.key}`}>Product</Label>
                  <Input
                    id={`product-${line.key}`}
                    list="adjustment-products"
                    value={line.productName}
                    onChange={(event) => chooseProduct(line.key, event.target.value)}
                    placeholder="Start typing a product name"
                    autoComplete="off"
                    aria-invalid={!!errors[`lines.${index}.productId`]}
                    required
                  />
                  {problem(`lines.${index}.productId`)}
                  {line.productName && !product && <p className="text-xs text-muted-foreground">Choose a product from the list.</p>}
                  {product && available !== null && (
                    <p className="text-xs text-muted-foreground" data-testid={`available-${index + 1}`}>
                      {chosenBatch ? `Batch ${chosenBatch.batchNumber ?? "with no number"} in ${locationName} now` : `In ${locationName} now`}: {plainNumber(available)} {product.baseUnitName}
                      {product.units.length > 1 && plainNumber(available) !== "0" && ` (${breakIntoUnits(available, product.baseUnitName, product.units)})`}
                    </p>
                  )}
                </div>
                <div className="flex flex-col gap-1.5 md:col-span-2">
                  <Label htmlFor={`direction-${line.key}`}>Change</Label>
                  <NativeSelect
                    id={`direction-${line.key}`}
                    value={line.direction}
                    onChange={(event) => chooseDirection(line.key, event.target.value === "add" ? "add" : "remove")}
                    aria-invalid={!!errors[`lines.${index}.direction`]}
                  >
                    <option value="remove">Take out</option>
                    <option value="add">Add</option>
                  </NativeSelect>
                  {problem(`lines.${index}.direction`)}
                </div>
                <div className="flex flex-col gap-1.5 md:col-span-1">
                  <Label htmlFor={`quantity-${line.key}`}>How many</Label>
                  <Input
                    id={`quantity-${line.key}`}
                    value={line.quantity}
                    onChange={(event) => change(line.key, { quantity: event.target.value })}
                    inputMode="decimal"
                    autoComplete="off"
                    aria-invalid={!!errors[`lines.${index}.quantity`]}
                    required
                  />
                </div>
                <div className="flex flex-col gap-1.5 md:col-span-2">
                  <Label htmlFor={`unit-${line.key}`}>Unit</Label>
                  <NativeSelect
                    id={`unit-${line.key}`}
                    value={line.unitId}
                    onChange={(event) => change(line.key, { unitId: event.target.value })}
                    disabled={!product}
                    aria-invalid={!!errors[`lines.${index}.unitId`]}
                    required
                  >
                    {!product && <option value="">—</option>}
                    {product?.units.map((candidate) => (
                      <option key={candidate.id} value={candidate.id}>
                        {candidate.isBase ? candidate.name : `${candidate.name} (${plainNumber(candidate.factor)} ${product.baseUnitName})`}
                      </option>
                    ))}
                  </NativeSelect>
                  {problem(`lines.${index}.unitId`)}
                </div>
                <div className="flex flex-col gap-1.5 md:col-span-2">
                  <Label htmlFor={`reason-${line.key}`}>Reason</Label>
                  <NativeSelect
                    id={`reason-${line.key}`}
                    value={line.reason}
                    onChange={(event) => change(line.key, { reason: event.target.value })}
                    aria-invalid={!!errors[`lines.${index}.reason`]}
                    required
                  >
                    <option value="">Choose…</option>
                    {ADJUSTMENT_REASONS.map((reason) => (
                      <option key={reason.value} value={reason.value}>
                        {reason.label}
                      </option>
                    ))}
                  </NativeSelect>
                  {problem(`lines.${index}.reason`)}
                </div>
                <div className="flex items-end justify-end md:col-span-1">
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    onClick={() => setLines((current) => (current.length === 1 ? [newLine()] : current.filter((other) => other.key !== line.key)))}
                    aria-label={`Remove line ${index + 1}`}
                    title="Remove this line"
                  >
                    <Trash2 className="size-4" aria-hidden />
                  </Button>
                </div>
                {batched(product) && product && (
                  <div className="md:col-span-11">
                    <BatchChoice
                      lineKey={line.key}
                      index={index}
                      value={line}
                      product={product}
                      taking={line.direction === "remove"}
                      label={line.direction === "remove" ? `Batch taken out of the ${locationName}` : "Batch the stock is added to"}
                      storeroomName={locationName}
                      errors={errors}
                      onChange={(patch) => change(line.key, patch)}
                    />
                  </div>
                )}
                {errors[`lines.${index}.quantity`] && <div className="md:col-span-12">{problem(`lines.${index}.quantity`)}</div>}
              </div>
            );
          })}

          <div>
            <Button type="button" variant="outline" onClick={() => setLines((current) => [...current, newLine()])}>
              <Plus className="size-4" aria-hidden /> Add another product
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="note">Note (needed if a reason is &quot;Other&quot;)</Label>
            <Input id="note" value={note} onChange={(event) => setNote(event.target.value)} aria-invalid={!!errors.note} autoComplete="off" maxLength={300} />
            {problem("note")}
          </div>
          {message && <Alert variant="destructive">{message}</Alert>}
          {errors.lines && <Alert variant="destructive">{errors.lines}</Alert>}
          <div>
            <Button type="submit" size="lg" disabled={pending}>
              {pending ? "Saving…" : options.appliesAtOnce ? "Adjust stock now" : "Send for approval"}
            </Button>
          </div>
        </CardContent>
      </Card>
    </form>
  );
}
