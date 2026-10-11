"use client";

import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { formatDay, nairaFromText } from "@/lib/format";
import { IMPORT_MAX_BYTES } from "@/lib/import-template";
import type { ImportPreview } from "@/server/business/imports";

type Checked = Omit<ImportPreview, "alreadyImported"> & { alreadyImported: { number: number; at: string; byName: string } | null };
type Answer = { done: boolean; number?: number; preview: Checked };

const many = (count: number, one: string, more: string) => `${count.toLocaleString("en-NG")} ${count === 1 ? one : more}`;

/**
 * Two steps on purpose: "Check the file" shows what would be brought in and every row with a
 * problem, saving nothing; only then can it be brought in. The file is sent again for the
 * second step, and the server checks it again from the beginning.
 */
export function ImportForm({ today, defaultStartingDay }: { today: string; defaultStartingDay: string }) {
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
        setMessage({
          good: true,
          text: `Brought in: ${many(p.newProducts, "product", "products")}, ${many(p.newCustomers, "customer", "customers")} and ${many(p.stockLines, "line", "lines")} of stock.`,
        });
        router.refresh();
      } else {
        setChecked(body.preview);
      }
    } catch {
      setMessage({ good: false, text: "The server could not be reached. Check the internet connection and try again." });
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="flex flex-col gap-5">
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="import-file">Excel file</Label>
          <Input id="import-file" ref={fileBox} type="file" accept=".xlsx" className="h-auto py-2" onChange={startAgain} disabled={busy !== null} />
          <p className="text-xs text-muted-foreground">The workbook you filled in (.xlsx, up to 5 MB).</p>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="import-day">Day the records start</Label>
          <Input
            id="import-day"
            type="date"
            value={startingDay}
            max={today}
            onChange={(event) => {
              setStartingDay(event.target.value);
              startAgain();
            }}
            disabled={busy !== null}
          />
          <p className="text-xs text-muted-foreground">The stock is as counted on this day, and debts are as owed on this day.</p>
        </div>
      </div>

      <div>
        <Button type="button" variant={checked ? "outline" : "default"} onClick={() => void send("preview")} disabled={busy !== null}>
          {busy === "check" ? "Checking…" : checked ? "Check again" : "Check the file"}
        </Button>
      </div>

      {message && (
        <p role="status" data-testid="import-message" className={message.good ? "text-sm font-medium text-emerald-700 dark:text-emerald-400" : "text-sm text-destructive"}>
          {message.text}
        </p>
      )}

      {checked && (
        <div className="flex flex-col gap-4 rounded-2xl bg-muted/50 p-4" data-testid="import-preview">
          <p className="font-semibold">
            {checked.fileName} — records starting {formatDay(checked.startingDay)}
          </p>
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
              <ul className="max-h-80 overflow-y-auto rounded-xl bg-background p-3 text-sm" data-testid="import-problems">
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
