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
import { Decimal } from "@/lib/decimal";
import { plainNumber } from "@/lib/format";
import { formatNaira, roundMoney } from "@/lib/money";
import type { ReceivingOptions, ReceivingProduct } from "@/server/business/stock";
import { quickCreateSupplierAction, receiveGoodsAction } from "../actions";

type Line = {
  key: string;
  productName: string;
  unitId: string;
  quantity: string;
  unitCost: string;
  batchNumber: string;
  expiryDate: string;
};

// The first line has a fixed key so the page the server sends matches what the browser draws;
// lines added later get a random one.
const newLine = (key: string = crypto.randomUUID()): Line => ({
  key,
  productName: "",
  unitId: "",
  quantity: "",
  unitCost: "",
  batchNumber: "",
  expiryDate: "",
});

/** For showing a running total only; the server works out the real figures again when saving. */
function lineTotalOrNull(quantity: string, unitCost: string): Decimal | null {
  if (!/^\d+(\.\d{1,3})?$/.test(quantity.trim()) || !/^\d+(\.\d{1,2})?$/.test(unitCost.trim())) return null;
  return roundMoney(new Decimal(quantity.trim()).times(unitCost.trim()));
}

export function ReceiveForm({ options }: { options: ReceivingOptions }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  // Made up once per delivery, so pressing Save twice can never record it twice.
  const [requestId, setRequestId] = useState(() => crypto.randomUUID());
  const [suppliers, setSuppliers] = useState(options.suppliers);
  const [supplierId, setSupplierId] = useState(options.suppliers.length === 1 ? options.suppliers[0].id : "");
  const [locationId, setLocationId] = useState(options.locations[0]?.id ?? "");
  const [receivedOn, setReceivedOn] = useState(options.today);
  const [backdateNote, setBackdateNote] = useState("");
  const [invoiceNumber, setInvoiceNumber] = useState("");
  const [note, setNote] = useState("");
  const [lines, setLines] = useState<Line[]>(() => [newLine("first")]);
  const [message, setMessage] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [newSupplier, setNewSupplier] = useState<string | null>(null);
  const [supplierError, setSupplierError] = useState<string | null>(null);

  const productByName = useMemo(
    () => new Map(options.products.map((product) => [product.name.toLowerCase(), product])),
    [options.products],
  );
  const find = (name: string): ReceivingProduct | undefined => productByName.get(name.trim().toLowerCase());

  const backdated = receivedOn !== "" && receivedOn < options.today;
  const total = lines.reduce<Decimal | null>((sum, line) => {
    const amount = lineTotalOrNull(line.quantity, line.unitCost);
    return amount ? (sum ?? new Decimal(0)).plus(amount) : sum;
  }, null);

  function change(key: string, patch: Partial<Line>) {
    setLines((current) => current.map((line) => (line.key === key ? { ...line, ...patch } : line)));
  }

  function chooseProduct(key: string, productName: string) {
    const product = find(productName);
    // Default to the largest unit the product is bought in (deliveries usually come in cartons or bags).
    change(key, { productName, unitId: product ? (product.units.at(-1)?.id ?? "") : "", batchNumber: "", expiryDate: "" });
  }

  function addSupplier() {
    const name = (newSupplier ?? "").trim();
    setSupplierError(null);
    startTransition(async () => {
      const result = await quickCreateSupplierAction(name);
      if (result.status === "success" && result.supplierId) {
        setSuppliers((current) => [...current, { id: result.supplierId!, name }].sort((a, b) => a.name.localeCompare(b.name)));
        setSupplierId(result.supplierId);
        setNewSupplier(null);
      } else if (result.status === "error") {
        setSupplierError(result.fieldErrors.name ?? result.message);
      }
    });
  }

  function save(event: React.FormEvent) {
    event.preventDefault();
    if (pending) return;
    setMessage(null);
    setErrors({});
    startTransition(async () => {
      const result = await receiveGoodsAction({
        requestId,
        supplierId,
        locationId,
        receivedOn,
        backdateNote: backdated ? backdateNote : "",
        invoiceNumber,
        note,
        lines: lines.map((line) => {
          const product = find(line.productName);
          return {
            productId: product?.id ?? "",
            unitId: line.unitId,
            quantity: line.quantity,
            unitCost: line.unitCost,
            batchNumber: product?.tracksBatch ? line.batchNumber : "",
            expiryDate: product?.tracksExpiry ? line.expiryDate : "",
          };
        }),
      });
      if (result.status === "success" && result.receiptId) {
        setRequestId(crypto.randomUUID());
        router.push(`/stock/receipts/${result.receiptId}`);
      } else if (result.status === "error") {
        setMessage(result.message);
        setErrors(result.fieldErrors);
      }
    });
  }

  const problem = (name: string) => (errors[name] ? <p className="text-xs text-destructive">{errors[name]}</p> : null);

  return (
    <form onSubmit={save} className="flex flex-col gap-4">
      <datalist id="receiving-products">
        {options.products.map((product) => (
          <option key={product.id} value={product.name}>
            {product.code ?? ""}
          </option>
        ))}
      </datalist>

      <Card>
        <CardContent className="grid gap-x-4 gap-y-4 md:grid-cols-2 xl:grid-cols-4">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="supplier">Supplier</Label>
            <NativeSelect id="supplier" value={supplierId} onChange={(event) => setSupplierId(event.target.value)} aria-invalid={!!errors.supplierId} required>
              <option value="">Choose a supplier…</option>
              {suppliers.map((supplier) => (
                <option key={supplier.id} value={supplier.id}>
                  {supplier.name}
                </option>
              ))}
            </NativeSelect>
            {problem("supplierId")}
            {newSupplier === null ? (
              <button type="button" onClick={() => setNewSupplier("")} className="w-fit text-xs text-link underline-offset-4 hover:underline">
                + New supplier
              </button>
            ) : (
              <div className="flex flex-col gap-1">
                <div className="flex gap-2">
                  <Input value={newSupplier} onChange={(event) => setNewSupplier(event.target.value)} placeholder="New supplier's name" aria-label="New supplier's name" className="h-9" />
                  <Button type="button" variant="outline" size="sm" onClick={addSupplier} disabled={pending} className="h-9">
                    Add
                  </Button>
                </div>
                {supplierError && <p className="text-xs text-destructive">{supplierError}</p>}
              </div>
            )}
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="location">Goes into</Label>
            <NativeSelect id="location" value={locationId} onChange={(event) => setLocationId(event.target.value)} aria-invalid={!!errors.locationId} required>
              {options.locations.map((location) => (
                <option key={location.id} value={location.id}>
                  {location.name}
                </option>
              ))}
            </NativeSelect>
            {problem("locationId")}
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="receivedOn">Date received</Label>
            <Input
              id="receivedOn"
              type="date"
              value={receivedOn}
              max={options.today}
              onChange={(event) => setReceivedOn(event.target.value)}
              disabled={!options.canBackdate}
              aria-invalid={!!errors.receivedOn}
              required
            />
            {problem("receivedOn")}
            {!options.canBackdate && <p className="text-xs text-muted-foreground">Only a manager or admin can enter an earlier date.</p>}
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="invoiceNumber">Supplier&apos;s invoice number (optional)</Label>
            <Input id="invoiceNumber" value={invoiceNumber} onChange={(event) => setInvoiceNumber(event.target.value)} autoComplete="off" />
            {problem("invoiceNumber")}
          </div>

          {backdated && (
            <div className="flex flex-col gap-1.5 md:col-span-2 xl:col-span-4">
              <Label htmlFor="backdateNote">Why is this delivery being entered with an earlier date?</Label>
              <Input
                id="backdateNote"
                value={backdateNote}
                onChange={(event) => setBackdateNote(event.target.value)}
                aria-invalid={!!errors.backdateNote}
                placeholder="For example: arrived after closing yesterday"
                required
              />
              {problem("backdateNote")}
              <p className="text-xs text-muted-foreground">
                This delivery will be marked as backdated, and the reason is kept in the activity log.
              </p>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardContent className="flex flex-col gap-4">
          {lines.map((line, index) => {
            const product = find(line.productName);
            const amount = lineTotalOrNull(line.quantity, line.unitCost);
            const unit = product?.units.find((candidate) => candidate.id === line.unitId);
            return (
              <div key={line.key} data-testid={`delivery-line-${index + 1}`} className="flex flex-col gap-2 border-b pb-4 last:border-0 last:pb-0">
                <div className="grid gap-3 md:grid-cols-12">
                  <div className="flex flex-col gap-1.5 md:col-span-4">
                    <Label htmlFor={`product-${line.key}`}>Product</Label>
                    <Input
                      id={`product-${line.key}`}
                      list="receiving-products"
                      value={line.productName}
                      onChange={(event) => chooseProduct(line.key, event.target.value)}
                      placeholder="Start typing a product name"
                      autoComplete="off"
                      aria-invalid={!!errors[`lines.${index}.productId`]}
                      required
                    />
                    {problem(`lines.${index}.productId`)}
                    {line.productName && !product && <p className="text-xs text-muted-foreground">Choose a product from the list.</p>}
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
                    <Label htmlFor={`quantity-${line.key}`}>How many arrived</Label>
                    <Input
                      id={`quantity-${line.key}`}
                      value={line.quantity}
                      onChange={(event) => change(line.key, { quantity: event.target.value })}
                      inputMode="decimal"
                      autoComplete="off"
                      aria-invalid={!!errors[`lines.${index}.quantity`]}
                      required
                    />
                    {problem(`lines.${index}.quantity`)}
                  </div>
                  <div className="flex flex-col gap-1.5 md:col-span-2">
                    <Label htmlFor={`cost-${line.key}`}>Cost of one {unit?.name ?? "unit"} (₦)</Label>
                    <Input
                      id={`cost-${line.key}`}
                      value={line.unitCost}
                      onChange={(event) => change(line.key, { unitCost: event.target.value })}
                      inputMode="decimal"
                      autoComplete="off"
                      aria-invalid={!!errors[`lines.${index}.unitCost`]}
                      required
                    />
                    {problem(`lines.${index}.unitCost`)}
                  </div>
                  <div className="flex items-end justify-between gap-2 md:col-span-2">
                    <div className="pb-2.5">
                      <p className="text-xs text-muted-foreground">Line total</p>
                      <p className="font-semibold tabular-nums" data-testid={`line-total-${index + 1}`}>
                        {amount ? formatNaira(amount) : "—"}
                      </p>
                    </div>
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
                </div>

                {(product?.tracksBatch || product?.tracksExpiry) && (
                  <div className="grid gap-3 md:grid-cols-12">
                    {product.tracksBatch && (
                      <div className="flex flex-col gap-1.5 md:col-span-4">
                        <Label htmlFor={`batch-${line.key}`}>Batch number</Label>
                        <Input
                          id={`batch-${line.key}`}
                          value={line.batchNumber}
                          onChange={(event) => change(line.key, { batchNumber: event.target.value })}
                          autoComplete="off"
                          aria-invalid={!!errors[`lines.${index}.batchNumber`]}
                          required
                        />
                        {problem(`lines.${index}.batchNumber`)}
                      </div>
                    )}
                    {product.tracksExpiry && (
                      <div className="flex flex-col gap-1.5 md:col-span-3">
                        <Label htmlFor={`expiry-${line.key}`}>Expiry date</Label>
                        <Input
                          id={`expiry-${line.key}`}
                          type="date"
                          value={line.expiryDate}
                          onChange={(event) => change(line.key, { expiryDate: event.target.value })}
                          aria-invalid={!!errors[`lines.${index}.expiryDate`]}
                          required
                        />
                        {problem(`lines.${index}.expiryDate`)}
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}

          <div className="flex flex-wrap items-center justify-between gap-3">
            <Button type="button" variant="outline" onClick={() => setLines((current) => [...current, newLine()])}>
              <Plus className="size-4" aria-hidden /> Add another product
            </Button>
            <p className="text-sm text-muted-foreground">
              Delivery total{" "}
              <span className="ml-2 text-xl font-semibold text-foreground tabular-nums" data-testid="delivery-total">
                {total ? formatNaira(total) : "—"}
              </span>
            </p>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="note">Note (optional)</Label>
            <Input id="note" value={note} onChange={(event) => setNote(event.target.value)} autoComplete="off" />
            {problem("note")}
          </div>
          {message && <Alert variant="destructive">{message}</Alert>}
          {errors.lines && <Alert variant="destructive">{errors.lines}</Alert>}
          <div>
            <Button type="submit" size="lg" disabled={pending}>
              {pending ? "Saving…" : "Save delivery"}
            </Button>
          </div>
        </CardContent>
      </Card>
    </form>
  );
}
