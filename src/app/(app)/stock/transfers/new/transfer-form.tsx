"use client";

import { ArrowLeftRight, Plus, Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useMemo, useState, useTransition } from "react";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { breakIntoUnits, plainNumber } from "@/lib/format";
import type { TransferOptions, TransferProduct } from "@/server/business/transfers";
import { transferStockAction } from "../../actions";

type Line = { key: string; productName: string; unitId: string; quantity: string };

// The first line has a fixed key so the page the server sends matches what the browser draws;
// lines added later get a random one.
const newLine = (key: string = crypto.randomUUID()): Line => ({ key, productName: "", unitId: "", quantity: "" });

export function TransferForm({ options }: { options: TransferOptions }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  // Made up once per transfer, so pressing Save twice can never move the stock twice.
  const [requestId, setRequestId] = useState(() => crypto.randomUUID());
  const [fromLocationId, setFromLocationId] = useState(options.locations[0]?.id ?? "");
  const [toLocationId, setToLocationId] = useState(options.locations[1]?.id ?? "");
  const [note, setNote] = useState("");
  const [lines, setLines] = useState<Line[]>(() => [newLine("first")]);
  const [message, setMessage] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});

  const productByName = useMemo(
    () => new Map(options.products.map((product) => [product.name.toLowerCase(), product])),
    [options.products],
  );
  const find = (name: string): TransferProduct | undefined => productByName.get(name.trim().toLowerCase());
  const locationName = (id: string) => options.locations.find((location) => location.id === id)?.name ?? "";

  function change(key: string, patch: Partial<Line>) {
    setLines((current) => current.map((line) => (line.key === key ? { ...line, ...patch } : line)));
  }

  function chooseProduct(key: string, productName: string) {
    const product = find(productName);
    // Default to the largest unit (stock usually moves by the carton or bag).
    change(key, { productName, unitId: product ? (product.units.at(-1)?.id ?? "") : "" });
  }

  function chooseFrom(id: string) {
    // With two locations, choosing one end decides the other.
    if (id === toLocationId) setToLocationId(fromLocationId);
    setFromLocationId(id);
  }

  function chooseTo(id: string) {
    if (id === fromLocationId) setFromLocationId(toLocationId);
    setToLocationId(id);
  }

  function swap() {
    setFromLocationId(toLocationId);
    setToLocationId(fromLocationId);
  }

  function save(event: React.FormEvent) {
    event.preventDefault();
    if (pending) return;
    setMessage(null);
    setErrors({});
    startTransition(async () => {
      const result = await transferStockAction({
        requestId,
        fromLocationId,
        toLocationId,
        note,
        lines: lines.map((line) => ({ productId: find(line.productName)?.id ?? "", unitId: line.unitId, quantity: line.quantity })),
      });
      if (result.status === "success" && result.transferId) {
        setRequestId(crypto.randomUUID());
        router.push(`/stock/transfers/${result.transferId}`);
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
        There is no stock to move yet. Stock arrives when a delivery is recorded under Receive goods.
      </p>
    );
  }

  return (
    <form onSubmit={save} className="flex flex-col gap-4">
      <datalist id="transfer-products">
        {options.products.map((product) => (
          <option key={product.id} value={product.name}>
            {product.code ?? ""}
          </option>
        ))}
      </datalist>

      <Card>
        <CardContent className="flex flex-wrap items-end gap-3">
          <div className="flex min-w-48 flex-1 flex-col gap-1.5 sm:max-w-xs">
            <Label htmlFor="from">Move from</Label>
            <NativeSelect id="from" value={fromLocationId} onChange={(event) => chooseFrom(event.target.value)} aria-invalid={!!errors.fromLocationId} required>
              {options.locations.map((location) => (
                <option key={location.id} value={location.id}>
                  {location.name}
                </option>
              ))}
            </NativeSelect>
            {problem("fromLocationId")}
          </div>
          <Button type="button" variant="outline" size="icon" onClick={swap} aria-label="Swap the two locations" title="Swap the two locations">
            <ArrowLeftRight className="size-4" aria-hidden />
          </Button>
          <div className="flex min-w-48 flex-1 flex-col gap-1.5 sm:max-w-xs">
            <Label htmlFor="to">Move to</Label>
            <NativeSelect id="to" value={toLocationId} onChange={(event) => chooseTo(event.target.value)} aria-invalid={!!errors.toLocationId} required>
              {options.locations.map((location) => (
                <option key={location.id} value={location.id}>
                  {location.name}
                </option>
              ))}
            </NativeSelect>
            {problem("toLocationId")}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="flex flex-col gap-4">
          {lines.map((line, index) => {
            const product = find(line.productName);
            const available = product ? (product.stock[fromLocationId] ?? "0") : null;
            return (
              <div key={line.key} data-testid={`transfer-line-${index + 1}`} className="grid gap-3 border-b pb-4 last:border-0 last:pb-0 md:grid-cols-12">
                <div className="flex flex-col gap-1.5 md:col-span-5">
                  <Label htmlFor={`product-${line.key}`}>Product</Label>
                  <Input
                    id={`product-${line.key}`}
                    list="transfer-products"
                    value={line.productName}
                    onChange={(event) => chooseProduct(line.key, event.target.value)}
                    placeholder="Start typing a product name"
                    autoComplete="off"
                    aria-invalid={!!errors[`lines.${index}.productId`]}
                    required
                  />
                  {problem(`lines.${index}.productId`)}
                  {line.productName && !product && <p className="text-xs text-muted-foreground">Choose a product from the list (only products with stock are shown).</p>}
                  {product && available !== null && (
                    <p className="text-xs text-muted-foreground" data-testid={`available-${index + 1}`}>
                      In {locationName(fromLocationId)} now: {plainNumber(available)} {product.baseUnitName}
                      {product.units.length > 1 && available !== "0" && ` (${breakIntoUnits(available, product.baseUnitName, product.units)})`}
                    </p>
                  )}
                </div>
                <div className="flex flex-col gap-1.5 md:col-span-3">
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
                <div className="flex flex-col gap-1.5 md:col-span-3">
                  <Label htmlFor={`quantity-${line.key}`}>How many to move</Label>
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
            <Label htmlFor="note">Note (optional)</Label>
            <Input id="note" value={note} onChange={(event) => setNote(event.target.value)} autoComplete="off" maxLength={300} />
            {problem("note")}
          </div>
          {message && <Alert variant="destructive">{message}</Alert>}
          {errors.lines && <Alert variant="destructive">{errors.lines}</Alert>}
          <div>
            <Button type="submit" size="lg" disabled={pending}>
              {pending ? "Moving…" : `Move to ${locationName(toLocationId)}`}
            </Button>
          </div>
        </CardContent>
      </Card>
    </form>
  );
}
