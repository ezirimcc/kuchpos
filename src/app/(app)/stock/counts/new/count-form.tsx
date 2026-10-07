"use client";

import { Search } from "lucide-react";
import { useRouter } from "next/navigation";
import { useMemo, useState, useTransition } from "react";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import type { CountSheet } from "@/server/business/counts";
import { submitCountAction } from "../../actions";

/** What has been typed, by product id and then unit id. An empty box means "not counted". */
type Entries = Record<string, Record<string, string>>;

export function CountForm({ sheet }: { sheet: CountSheet }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  // Made up once per count, so pressing Save twice can never record it twice.
  const [requestId, setRequestId] = useState(() => crypto.randomUUID());
  const [locationId, setLocationId] = useState("");
  const [category, setCategory] = useState("");
  const [search, setSearch] = useState("");
  const [note, setNote] = useState("");
  const [entries, setEntries] = useState<Entries>({});
  const [message, setMessage] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});

  const counted = useMemo(
    () => sheet.products.filter((product) => Object.values(entries[product.id] ?? {}).some((value) => value.trim() !== "")),
    [sheet.products, entries],
  );
  const words = search.trim().toLowerCase();
  const shown = sheet.products.filter(
    (product) =>
      (category === "" || (category === "none" ? product.categoryId === null : product.categoryId === category)) &&
      (words === "" || product.name.toLowerCase().includes(words) || (product.code ?? "").toLowerCase().includes(words)),
  );
  const hidden = counted.filter((product) => !shown.includes(product)).length;

  function type(productId: string, unitId: string, value: string) {
    setEntries((current) => ({ ...current, [productId]: { ...current[productId], [unitId]: value } }));
  }

  function save(event: React.FormEvent) {
    event.preventDefault();
    if (pending) return;
    setMessage(null);
    setErrors({});
    startTransition(async () => {
      // The category is recorded only if everything counted belongs to it.
      const within = category !== "" && counted.every((product) => (category === "none" ? product.categoryId === null : product.categoryId === category));
      const result = await submitCountAction({
        requestId,
        locationId,
        category: within ? category : "",
        note,
        lines: counted.map((product) => ({
          productId: product.id,
          entries: Object.entries(entries[product.id] ?? {})
            .filter(([, quantity]) => quantity.trim() !== "")
            .map(([unitId, quantity]) => ({ unitId, quantity })),
        })),
      });
      if (result.status === "success" && result.countId) {
        setRequestId(crypto.randomUUID());
        router.push(`/stock/counts/${result.countId}`);
      } else if (result.status === "error") {
        setMessage(result.message);
        setErrors(result.fieldErrors);
        // Bring a hidden problem into view.
        if (Object.keys(result.fieldErrors).some((key) => key.startsWith("lines."))) {
          setCategory("");
          setSearch("");
        }
      }
    });
  }

  if (sheet.products.length === 0) {
    return (
      <p className="rounded-3xl border border-dashed p-10 text-center text-sm text-muted-foreground">
        There are no products to count yet. Add products under Products &amp; Categories first.
      </p>
    );
  }

  return (
    <form onSubmit={save} className="flex flex-col gap-4">
      <Card>
        <CardContent className="flex flex-wrap items-end gap-3">
          <div className="flex min-w-48 flex-col gap-1.5">
            <Label htmlFor="location">Where are you counting?</Label>
            <NativeSelect id="location" value={locationId} onChange={(event) => setLocationId(event.target.value)} aria-invalid={!!errors.locationId} required>
              <option value="">Choose a location…</option>
              {sheet.locations.map((location) => (
                <option key={location.id} value={location.id}>
                  {location.name}
                </option>
              ))}
            </NativeSelect>
            {errors.locationId && <p className="text-xs text-destructive">{errors.locationId}</p>}
          </div>
          <div className="flex min-w-48 flex-col gap-1.5">
            <Label htmlFor="category">Show only</Label>
            <NativeSelect id="category" value={category} onChange={(event) => setCategory(event.target.value)}>
              <option value="">All categories</option>
              {sheet.categories.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.name}
                </option>
              ))}
              <option value="none">No category</option>
            </NativeSelect>
          </div>
          <div className="flex min-w-56 flex-1 flex-col gap-1.5 sm:max-w-sm">
            <Label htmlFor="find">Find a product</Label>
            <div className="relative">
              <Search className="pointer-events-none absolute top-1/2 left-3.5 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
              <Input id="find" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Name or code" autoComplete="off" className="pl-10" />
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="flex flex-col">
          <p className="pb-3 text-sm text-muted-foreground">
            Fill in only what you count. A product left empty is <strong className="font-medium text-foreground">not counted</strong> —
            type 0 if you looked and there is none.
          </p>
          {shown.length === 0 && <p className="py-6 text-center text-sm text-muted-foreground">No product matches.</p>}
          {shown.map((product) => (
            <div
              key={product.id}
              data-testid={`count-product-${product.name}`}
              className="flex flex-wrap items-center gap-x-4 gap-y-2 border-t py-3 first:border-t-0"
            >
              <div className="min-w-56 flex-1">
                <p className="font-medium">{product.name}</p>
                <p className="text-xs text-muted-foreground">
                  {[product.code, product.category].filter(Boolean).join(" · ") || "—"}
                </p>
                {errors[`lines.${product.id}`] && <p className="text-xs text-destructive">{errors[`lines.${product.id}`]}</p>}
              </div>
              <div className="flex flex-wrap items-center gap-3">
                {product.units.map((unit) => (
                  <label key={unit.id} className="flex items-center gap-2 text-sm text-muted-foreground">
                    <Input
                      value={entries[product.id]?.[unit.id] ?? ""}
                      onChange={(event) => type(product.id, unit.id, event.target.value)}
                      inputMode="decimal"
                      autoComplete="off"
                      aria-label={`${product.name}: ${unit.name}`}
                      aria-invalid={!!errors[`lines.${product.id}`]}
                      className="h-9 w-24 text-right tabular-nums"
                    />
                    {unit.name}
                  </label>
                ))}
              </div>
            </div>
          ))}
        </CardContent>
      </Card>

      <Card>
        <CardContent className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="note">Note (optional)</Label>
            <Input id="note" value={note} onChange={(event) => setNote(event.target.value)} autoComplete="off" maxLength={300} />
            {errors.note && <p className="text-xs text-destructive">{errors.note}</p>}
          </div>
          {message && <Alert variant="destructive">{message}</Alert>}
          {errors.lines && <Alert variant="destructive">{errors.lines}</Alert>}
          <div className="flex flex-wrap items-center gap-4">
            <Button type="submit" size="lg" disabled={pending || counted.length === 0}>
              {pending ? "Saving…" : "Save count"}
            </Button>
            <p className="text-sm text-muted-foreground" data-testid="counted-so-far">
              {counted.length === 0
                ? "Nothing counted yet."
                : `${counted.length} product${counted.length === 1 ? "" : "s"} counted`}
              {hidden > 0 && ` (${hidden} not shown by the filter above)`}
            </p>
          </div>
        </CardContent>
      </Card>
    </form>
  );
}
