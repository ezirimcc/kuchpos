"use client";

import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { formatDay, nairaFromText } from "@/lib/format";
import { IMPORT_MAX_BYTES } from "@/lib/import-template";
import type { HistoryPreview } from "@/server/business/import-history";
import type { ImportPreview } from "@/server/business/imports";

type Sent<Preview> = Omit<Preview, "alreadyImported"> & { alreadyImported: { number: number; at: string; byName: string } | null };
type Checked = ({ part: "setup" } & Sent<ImportPreview>) | ({ part: "history" } & Sent<HistoryPreview>);
type Answer = { done: boolean; number?: number; exceptions?: number; preview: Sent<ImportPreview> | Sent<HistoryPreview> };

const many = (count: number, one: string, more: string) => `${count.toLocaleString("en-NG")} ${count === 1 ? one : more}`;

/**
 * Two steps on purpose: "Check the file" shows what would be brought in and every row with a
 * problem, saving nothing; only then can it be brought in. The file is sent again for the
 * second step, and the server checks it again from the beginning.
 *
 * `part` says which sheets of the workbook this form brings in: Products, Customers and
 * Stock ("setup"), or Deliveries and Sales ("history").
 */
export function ImportForm({ part, today, defaultStartingDay }: { part: "setup" | "history"; today: string; defaultStartingDay: string }) {
  const router = useRouter();
  const fileBox = useRef<HTMLInputElement>(null);
  const [startingDay, setStartingDay] = useState(defaultStartingDay);
  const [checked, setChecked] = useState<Checked | null>(null);
  const [message, setMessage] = useState<{ good: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState<"check" | "run" | null>(null);

  function startAgain() {
    setChecked(null);
    setMessage(null);
  }

  async function send(mode: "preview" | "run") {
    if (busy) return;
    const file = fileBox.current?.files?.[0];
    if (!file) return setMessage({ good: false, text: "Choose the Excel file first." });
    if (file.size > IMPORT_MAX_BYTES) return setMessage({ good: false, text: "That file is larger than 5 MB. Check that you chose the right file." });
    setBusy(mode === "run" ? "run" : "check");
    setMessage(null);
    try {
      const form = new FormData();
      form.set("mode", mode);
      form.set("part", part);
      form.set("startingDay", startingDay);
      form.set("file", file);
      const response = await fetch("/api/import", { method: "POST", body: form });
      const body = (await response.json().catch(() => null)) as (Answer & { message?: string; fieldErrors?: Record<string, string> }) | null;
      if (response.status === 401) return setMessage({ good: false, text: "You have been signed out. Sign in again, then choose the file once more." });
      if (response.status === 403) return setMessage({ good: false, text: "Only the admin can bring data in." });
      if (response.status === 422 && body) {
        if (mode === "run") setChecked(null);
        return setMessage({ good: false, text: body.fieldErrors?.startingDay ?? body.message ?? "The file was not accepted." });
      }
      if (!response.ok || !body) return setMessage({ good: false, text: "Something went wrong and nothing was brought in. Try again." });
      if (body.done) {
        setChecked(null);
        if (fileBox.current) fileBox.current.value = "";
        const p = body.preview;
        const short = body.exceptions ?? 0;
        setMessage({
          good: true,
          text:
            "newProducts" in p
              ? `Brought in: ${many(p.newProducts, "product", "products")}, ${many(p.newCustomers, "customer", "customers")} and ${many(p.stockLines, "line", "lines")} of stock.`
              : `Brought in: ${many(p.deliveries, "delivery", "deliveries")} and ${many(p.sales, "sale", "sales")}.` +
                (short > 0 ? ` ${many(short, "product was", "products were")} sold beyond the stock on record: see Sales, then Offline exceptions, and count those products.` : ""),
        });
        router.refresh();
      } else {
        setChecked({ part, ...body.preview } as Checked);
      }
    } catch {
      setMessage({ good: false, text: "The server could not be reached. Check the internet connection and try again." });
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="flex flex-col gap-5" data-testid={`import-form-${part}`}>
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`import-file-${part}`}>Excel file</Label>
          <Input id={`import-file-${part}`} ref={fileBox} type="file" accept=".xlsx" className="h-auto py-2" onChange={startAgain} disabled={busy !== null} />
          <p className="text-xs text-muted-foreground">The workbook you filled in (.xlsx, up to 5 MB).</p>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`import-day-${part}`}>Day the records start</Label>
          <Input
            id={`import-day-${part}`}
            type="date"
            value={startingDay}
            max={today}
            onChange={(event) => {
              setStartingDay(event.target.value);
              startAgain();
            }}
            disabled={busy !== null}
          />
          <p className="text-xs text-muted-foreground">
            {part === "setup" ? "The stock is as counted on this day, and debts are as owed on this day." : "No delivery or sale in the file may be earlier than this day."}
          </p>
        </div>
      </div>

      <div>
        <Button type="button" variant={checked ? "outline" : "default"} onClick={() => void send("preview")} disabled={busy !== null}>
          {busy === "check" ? "Checking…" : checked ? "Check again" : "Check the file"}
        </Button>
      </div>

      {message && (
        <p role="status" data-testid={`import-message-${part}`} className={message.good ? "text-sm font-medium text-emerald-700 dark:text-emerald-400" : "text-sm text-destructive"}>
          {message.text}
        </p>
      )}

      {checked && (
        <div className="flex flex-col gap-4 rounded-2xl bg-muted/50 p-4" data-testid={`import-preview-${part}`}>
          <p className="font-semibold">
            {checked.fileName} — records starting {formatDay(checked.startingDay)}
          </p>
          {checked.part === "history" ? (
            <ul className="grid gap-1 text-sm sm:grid-cols-2">
              <li>
                Deliveries: <strong>{checked.deliveries}</strong> ({many(checked.deliveryLines, "line", "lines")}), costing {nairaFromText(checked.deliveriesCost)}
                {checked.newSuppliers > 0 ? ` — ${many(checked.newSuppliers, "new supplier", "new suppliers")}` : ""}
              </li>
              <li>
                Sales: <strong>{checked.sales}</strong> ({many(checked.saleLines, "line", "lines")}), worth {nairaFromText(checked.salesTotal)}
              </li>
              <li>
                Of that on credit: {nairaFromText(checked.creditTotal)}; discounts given: {nairaFromText(checked.discountTotal)}
              </li>
              {checked.firstDay && checked.lastDay && (
                <li className="text-muted-foreground">
                  From {formatDay(checked.firstDay)} to {formatDay(checked.lastDay)}
                </li>
              )}
              {checked.salesShortOfStock > 0 && (
                <li className="sm:col-span-2" data-testid="import-short">
                  {many(checked.salesShortOfStock, "sale takes", "sales take")} more out of stock than the records hold. They will still be brought in; the stock of those
                  products goes to zero, and each is listed under Sales → Offline exceptions so that the product can be counted.
                </li>
              )}
            </ul>
          ) : (
          <ul className="grid gap-1 text-sm sm:grid-cols-2">
            <li>
              New products: <strong>{checked.newProducts}</strong> ({many(checked.newUnits, "unit", "units")}, {many(checked.newCategories, "new category", "new categories")})
            </li>
            <li>
              New customers: <strong>{checked.newCustomers}</strong>, owing {nairaFromText(checked.openingDebt)} in all
            </li>
            <li>
              Stock: <strong>{many(checked.stockLines, "line", "lines")}</strong>, worth {nairaFromText(checked.stockValue)} at cost — all onto the Shelf
            </li>
            <li className="text-muted-foreground">
              Already in KuchPos and left as they are: {many(checked.productsAlreadyThere, "product", "products")}, {many(checked.customersAlreadyThere, "customer", "customers")}
            </li>
          </ul>
          )}

          {checked.alreadyImported && (
            <p className="text-sm text-destructive">
              This exact file was already brought in by {checked.alreadyImported.byName}. It cannot be brought in twice.
            </p>
          )}

          {checked.problemCount > 0 && (
            <div className="flex flex-col gap-2">
              <p className="text-sm font-medium text-destructive">
                {many(checked.problemCount, "problem", "problems")} to correct in Excel. Nothing can be brought in until there are none.
                {checked.problemCount > checked.problems.length ? ` The first ${checked.problems.length} are listed.` : ""}
              </p>
              <ul className="max-h-80 overflow-y-auto rounded-xl bg-background p-3 text-sm" data-testid={`import-problems-${part}`}>
                {checked.problems.map((problem, index) => (
                  <li key={index} className="flex gap-3 border-b py-1.5 last:border-b-0">
                    <span className="w-32 shrink-0 font-medium tabular-nums">
                      {problem.sheet}
                      {problem.row ? `, row ${problem.row}` : ""}
                    </span>
                    <span>{problem.message}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {checked.canImport && (
            <div className="flex flex-wrap items-center gap-3">
              <Button type="button" onClick={() => void send("run")} disabled={busy !== null}>
                {busy === "run" ? "Bringing it in… do not close this page" : "Bring it in"}
              </Button>
              <p className="text-sm text-muted-foreground">No problems found. Either all of it is saved, or none of it.</p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
