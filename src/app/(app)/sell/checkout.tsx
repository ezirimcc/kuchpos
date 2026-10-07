"use client";

import { Plus, RefreshCw, Search, Trash2, X } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import { rememberTerminal, useRememberedTerminal } from "@/components/terminal-choice";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { Decimal } from "@/lib/decimal";
import { nairaFromText, plainNumber } from "@/lib/format";
import { formatNaira, lineTotal, moneyToString, sumMoney } from "@/lib/money";
import type { CheckoutCatalogue, CheckoutProduct } from "@/server/business/sales";
import { postSaleAction } from "../sales/actions";

type CartLine = { key: string; productId: string; unitId: string; quantity: string; fromStoreroom: boolean };

/**
 * One part of how the sale is paid. With a single part its amount is the whole total and is
 * not typed; when the payment is split, each part's amount is typed.
 */
type PaymentPart = { key: string; methodId: string; amount: string; tendered: string; reference: string };

const MAX_MATCHES = 8;

const isQuantity = (text: string) => /^\d+(\.\d{1,3})?$/.test(text.trim()) && new Decimal(text.trim()).greaterThan(0);
const isMoney = (text: string) => /^\d+(\.\d{1,2})?$/.test(text.trim());

/**
 * The checkout. Everything on it is worked out here from the copy of the catalogue the page
 * was given — for the cashier's eyes only: the server works it all out again when the sale
 * is sent, and refuses the sale if anything differs.
 */
export function Checkout({ catalogue }: { catalogue: CheckoutCatalogue }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  // The sale's unique ID, made up here before anything is sent: pressing the button many
  // times, or the network repeating itself, can only ever save this sale once.
  const [requestId, setRequestId] = useState(() => crypto.randomUUID());
  const remembered = useRememberedTerminal();
  const [chosenTerminal, setChosenTerminal] = useState<string | null>(null);
  // This computer remembers which terminal it is. With one terminal there is nothing to choose;
  // with several, nothing is assumed: receipt numbers belong to the terminal, so the person
  // must say which one this computer is, once.
  const terminalId =
    [chosenTerminal, remembered].find((id) => id && catalogue.terminals.some((terminal) => terminal.id === id)) ??
    (catalogue.terminals.length === 1 ? catalogue.terminals[0].id : "");
  const [lines, setLines] = useState<CartLine[]>([]);
  const [search, setSearch] = useState("");
  const [highlighted, setHighlighted] = useState(0);
  const [parts, setParts] = useState<PaymentPart[]>(() => [
    { key: "first", methodId: catalogue.paymentMethods[0]?.id ?? "", amount: "", tendered: "", reference: "" },
  ]);
  const [message, setMessage] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const searchBox = useRef<HTMLInputElement>(null);
  const cashBox = useRef<HTMLInputElement>(null);
  const focusQuantityOf = useRef<string | null>(null);

  const productById = useMemo(() => new Map(catalogue.products.map((product) => [product.id, product])), [catalogue.products]);

  // F2: the search box. F4: the cash box.
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key === "F2") {
        event.preventDefault();
        searchBox.current?.focus();
      } else if (event.key === "F4") {
        event.preventDefault();
        cashBox.current?.focus();
        cashBox.current?.select();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // After a product is added, the cursor goes to its "how many" box.
  useEffect(() => {
    if (!focusQuantityOf.current) return;
    const box = document.getElementById(`quantity-${focusQuantityOf.current}`) as HTMLInputElement | null;
    focusQuantityOf.current = null;
    box?.focus();
    box?.select();
  }, [lines]);

  const words = search.trim().toLowerCase();
  const matches = useMemo(() => {
    if (words === "") return [];
    const exact = catalogue.products.filter(
      (product) => product.barcode?.toLowerCase() === words || product.code?.toLowerCase() === words,
    );
    const others = catalogue.products.filter(
      (product) =>
        !exact.includes(product) && (product.name.toLowerCase().includes(words) || (product.code ?? "").toLowerCase().includes(words)),
    );
    return [...exact, ...others].slice(0, MAX_MATCHES);
  }, [catalogue.products, words]);

  function changeTerminal(id: string) {
    setChosenTerminal(id);
    rememberTerminal(id);
  }

  function add(product: CheckoutProduct) {
    const unit = product.units[0];
    if (!unit) return;
    setSearch("");
    setHighlighted(0);
    setMessage(null);
    setErrors({});
    setLines((current) => {
      // The same product in the same unit again: one more of it, not a second line.
      const same = current.find((line) => line.productId === product.id && line.unitId === unit.id && !line.fromStoreroom);
      if (same && /^\d+$/.test(same.quantity.trim())) {
        focusQuantityOf.current = same.key;
        return current.map((line) => (line === same ? { ...line, quantity: String(Number.parseInt(line.quantity, 10) + 1) } : line));
      }
      const key = crypto.randomUUID();
      focusQuantityOf.current = key;
      return [...current, { key, productId: product.id, unitId: unit.id, quantity: "1", fromStoreroom: false }];
    });
  }

  function change(key: string, patch: Partial<CartLine>) {
    setErrors({});
    setLines((current) => current.map((line) => (line.key === key ? { ...line, ...patch } : line)));
  }

  function onSearchKey(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setHighlighted((index) => Math.min(index + 1, Math.max(matches.length - 1, 0)));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setHighlighted((index) => Math.max(index - 1, 0));
    } else if (event.key === "Escape") {
      setSearch("");
    } else if (event.key === "Enter") {
      event.preventDefault();
      const chosen = matches[Math.min(highlighted, matches.length - 1)];
      if (chosen) add(chosen);
      // Enter on an empty search box means "that is everything": on to the cash.
      else if (words === "" && lines.length > 0) {
        cashBox.current?.focus();
        cashBox.current?.select();
      }
    }
  }

  // --- What the cashier sees: amounts worked out from the browser's copy of the prices ---
  const view = lines.map((line) => {
    const product = productById.get(line.productId);
    const unit = product?.units.find((candidate) => candidate.id === line.unitId);
    const valid = !!product && !!unit && isQuantity(line.quantity) && (product.allowsFraction || /^\d+$/.test(line.quantity.trim()));
    const amount = valid ? lineTotal(new Decimal(line.quantity.trim()), new Decimal(unit!.price)) : null;
    const baseQuantity = valid ? new Decimal(line.quantity.trim()).times(unit!.factor) : null;
    return { line, product, unit, amount, baseQuantity };
  });
  const allValid = view.length > 0 && view.every((entry) => entry.amount !== null);
  const total = allValid ? sumMoney(view.map((entry) => entry.amount!)) : null;

  // --- How it is paid ----------------------------------------------------------------
  const split = parts.length > 1;
  const methodOf = (part: PaymentPart) => catalogue.paymentMethods.find((method) => method.id === part.methodId);
  const paid = parts.map((part) => {
    const method = methodOf(part);
    const isCash = method?.kind === "CASH";
    // A single payment is for the whole total; a split one is for what was typed.
    const amount = split ? (isMoney(part.amount) && new Decimal(part.amount.trim()).greaterThan(0) ? new Decimal(part.amount.trim()) : null) : total;
    // Cash handed over. When the payment is split it may be left empty, meaning "exactly its amount".
    const typed = part.tendered.trim();
    const received = !isCash ? null : typed === "" ? (split ? amount : null) : isMoney(typed) ? new Decimal(typed) : null;
    const short = isCash && amount && received && received.lessThan(amount) ? amount.minus(received) : null;
    const badCash = isCash && typed !== "" && !isMoney(typed);
    const sound = !!method && !!amount && (!isCash || (!!received && !short));
    return { part, method, isCash, amount, received, short, badCash, sound };
  });
  const paidSoFar = paid.every((entry) => entry.amount) ? sumMoney(paid.map((entry) => entry.amount!)) : null;
  const leftToPay = total && paidSoFar ? total.minus(paidSoFar) : null;
  const changeDue =
    total && paid.every((entry) => entry.sound)
      ? sumMoney(paid.filter((entry) => entry.isCash).map((entry) => entry.received!.minus(entry.amount!)))
      : null;
  const hasCash = paid.some((entry) => entry.isCash);
  const terminal = catalogue.terminals.find((candidate) => candidate.id === terminalId);
  const tillClosed = !!terminal && !terminal.tillOpen;
  const ready = !!total && paid.every((entry) => entry.sound) && !!leftToPay && leftToPay.isZero() && !!terminal && !tillClosed;

  function changePart(key: string, patch: Partial<PaymentPart>) {
    setErrors({});
    setParts((current) => current.map((part) => (part.key === key ? { ...part, ...patch } : part)));
  }

  function addPart() {
    setErrors({});
    setParts((current) => {
      const unused = catalogue.paymentMethods.find((method) => !current.some((part) => part.methodId === method.id));
      return [...current, { key: crypto.randomUUID(), methodId: unused?.id ?? "", amount: "", tendered: "", reference: "" }];
    });
  }

  function removePart(key: string) {
    setErrors({});
    setParts((current) => (current.length === 1 ? current : current.filter((part) => part.key !== key)));
  }

  function complete(event: React.FormEvent) {
    event.preventDefault();
    if (pending || !ready || !total) return;
    setMessage(null);
    setErrors({});
    startTransition(async () => {
      const result = await postSaleAction({
        requestId,
        terminalId,
        deviceTime: new Date().toISOString(),
        expectedTotal: moneyToString(total),
        payments: paid.map(({ part, isCash, amount }) => ({
          methodId: part.methodId,
          amount: moneyToString(amount!),
          tendered: isCash ? part.tendered.trim() : "",
          reference: isCash ? "" : part.reference.trim(),
        })),
        lines: view.map(({ line, unit }) => ({
          productId: line.productId,
          unitId: line.unitId,
          quantity: line.quantity.trim(),
          unitPrice: unit!.price,
          fromStoreroom: line.fromStoreroom,
        })),
      });
      if (result.status === "success" && result.sale) {
        setRequestId(crypto.randomUUID());
        router.push(`/sales/${result.sale.id}?sold=1`);
      } else if (result.status === "error") {
        setMessage(result.message);
        setErrors(result.fieldErrors);
      }
    });
  }

  if (catalogue.terminals.length === 0) {
    return (
      <p className="rounded-3xl border border-dashed p-10 text-center text-sm text-muted-foreground">
        This business has no checkout terminal in use. Ask the admin to add one under Settings.
      </p>
    );
  }
  if (catalogue.products.length === 0) {
    return (
      <p className="rounded-3xl border border-dashed p-10 text-center text-sm text-muted-foreground">
        There is nothing on sale yet. Products need a selling price before they can be sold.
      </p>
    );
  }

  const lineProblem = (index: number) =>
    ["productId", "unitId", "quantity", "unitPrice", "fromStoreroom"].map((field) => errors[`lines.${index}.${field}`]).find(Boolean);
  const pricesChanged = Object.keys(errors).some((key) => key.endsWith(".unitPrice") || key.endsWith(".unitId") || key === "expectedTotal");

  return (
    <form onSubmit={complete} className="grid items-start gap-4 xl:grid-cols-3">
      <div className="flex flex-col gap-4 xl:col-span-2">
        <Card>
          <CardContent className="flex flex-col gap-2">
            <div className="relative">
              <Search className="pointer-events-none absolute top-1/2 left-4 size-5 -translate-y-1/2 text-muted-foreground" aria-hidden />
              <Input
                ref={searchBox}
                value={search}
                onChange={(event) => {
                  setSearch(event.target.value);
                  setHighlighted(0);
                }}
                onKeyDown={onSearchKey}
                placeholder="Type a product name or code, or scan a barcode"
                aria-label="Find a product"
                data-testid="checkout-search"
                autoComplete="off"
                autoFocus
                className="h-12 pl-12 text-base"
              />
            </div>
            {words !== "" && (
              <ul className="flex flex-col" role="listbox" aria-label="Matching products" data-testid="checkout-matches">
                {matches.length === 0 && <li className="px-3 py-2 text-sm text-muted-foreground">No product on sale matches “{search.trim()}”.</li>}
                {matches.map((product, index) => (
                  <li key={product.id} role="option" aria-selected={index === highlighted}>
                    <button
                      type="button"
                      onClick={() => add(product)}
                      onMouseEnter={() => setHighlighted(index)}
                      className={
                        index === highlighted
                          ? "flex w-full items-center justify-between gap-3 rounded-xl bg-accent px-3 py-2 text-left text-sm text-accent-foreground"
                          : "flex w-full items-center justify-between gap-3 rounded-xl px-3 py-2 text-left text-sm"
                      }
                    >
                      <span>
                        <span className="font-medium">{product.name}</span>
                        {product.code && <span className="ml-2 opacity-70">{product.code}</span>}
                      </span>
                      <span className="shrink-0 tabular-nums opacity-80">
                        {product.units.map((unit) => `${unit.name} ${nairaFromText(unit.price)}`).join(" · ")}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardContent className="flex flex-col">
            {view.length === 0 && (
              <p className="py-8 text-center text-sm text-muted-foreground" data-testid="cart-empty">
                Nothing in this sale yet. Find a product above and press Enter.
              </p>
            )}
            {view.map(({ line, product, amount, baseQuantity }, index) => {
              const known = product ? new Decimal(line.fromStoreroom ? product.inStoreroom : product.onShelf) : null;
              const over = known && baseQuantity && baseQuantity.greaterThan(known);
              const problem = lineProblem(index);
              return (
                <div key={line.key} data-testid={`cart-line-${index + 1}`} className="flex flex-col gap-1.5 border-t py-3 first:border-t-0 first:pt-0">
                  <div className="grid items-center gap-3 md:grid-cols-12">
                    <div className="md:col-span-4">
                      <p className="font-medium">{product?.name ?? "This product is no longer on sale"}</p>
                      {product && known && (
                        <p className={over ? "text-xs font-medium text-destructive" : "text-xs text-muted-foreground"}>
                          {line.fromStoreroom ? "In Storeroom" : "On Shelf"}: {plainNumber(known.toFixed(3))} {product.baseUnitName}
                          {over ? " — not enough" : ""}
                        </p>
                      )}
                    </div>
                    <div className="md:col-span-2">
                      <Input
                        id={`quantity-${line.key}`}
                        value={line.quantity}
                        onChange={(event) => change(line.key, { quantity: event.target.value })}
                        onKeyDown={(event) => {
                          if (event.key === "Enter") {
                            event.preventDefault();
                            searchBox.current?.focus();
                          }
                        }}
                        inputMode="decimal"
                        autoComplete="off"
                        aria-label={`How many: ${product?.name ?? ""}`}
                        aria-invalid={amount === null || !!errors[`lines.${index}.quantity`]}
                        className="text-right tabular-nums"
                      />
                    </div>
                    <div className="md:col-span-3">
                      <NativeSelect
                        value={line.unitId}
                        onChange={(event) => change(line.key, { unitId: event.target.value })}
                        aria-label={`Unit: ${product?.name ?? ""}`}
                      >
                        {product?.units.map((candidate) => (
                          <option key={candidate.id} value={candidate.id}>
                            {candidate.name} — {nairaFromText(candidate.price)}
                          </option>
                        ))}
                      </NativeSelect>
                    </div>
                    <p className="text-right font-semibold tabular-nums md:col-span-2" data-testid={`cart-line-total-${index + 1}`}>
                      {amount ? formatNaira(amount) : "—"}
                    </p>
                    <div className="flex justify-end md:col-span-1">
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        onClick={() => {
                          setErrors({});
                          setLines((current) => current.filter((other) => other.key !== line.key));
                          searchBox.current?.focus();
                        }}
                        aria-label={`Remove ${product?.name ?? "this line"}`}
                        title="Remove this line"
                      >
                        <Trash2 className="size-4" aria-hidden />
                      </Button>
                    </div>
                  </div>
                  {catalogue.canSellFromStoreroom && (
                    <label className="flex w-fit items-center gap-2 text-xs text-muted-foreground">
                      <input
                        type="checkbox"
                        checked={line.fromStoreroom}
                        onChange={(event) => change(line.key, { fromStoreroom: event.target.checked })}
                        className="size-3.5 accent-[var(--primary)]"
                      />
                      Take this straight from the Storeroom
                    </label>
                  )}
                  {amount === null && product && !problem && (
                    <p className="text-xs text-destructive">
                      {product.allowsFraction
                        ? "Enter how many, as a number greater than zero."
                        : `${product.name} is sold in whole units only. Enter a whole number.`}
                    </p>
                  )}
                  {problem && <p className="text-xs text-destructive">{problem}</p>}
                </div>
              );
            })}
          </CardContent>
        </Card>
      </div>

      <Card className="xl:sticky xl:top-3">
        <CardContent className="flex flex-col gap-4">
          {catalogue.terminals.length > 1 ? (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="terminal">This checkout</Label>
              <NativeSelect
                id="terminal"
                value={terminalId}
                onChange={(event) => changeTerminal(event.target.value)}
                aria-invalid={!!errors.terminalId || terminalId === ""}
              >
                {terminalId === "" && <option value="">Choose which checkout this computer is…</option>}
                {catalogue.terminals.map((terminal) => (
                  <option key={terminal.id} value={terminal.id}>
                    {terminal.code} — {terminal.name}
                  </option>
                ))}
              </NativeSelect>
              {terminalId === "" && (
                <p className="text-xs text-destructive">Choose once; this computer will remember it. Its code starts every receipt number.</p>
              )}
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">
              Checkout {catalogue.terminals[0].code} — {catalogue.terminals[0].name}
            </p>
          )}
          {errors.terminalId && <p className="text-xs text-destructive">{errors.terminalId}</p>}

          <div>
            <p className="text-sm text-muted-foreground">Total to pay</p>
            <p className="text-4xl font-semibold tracking-tight tabular-nums" data-testid="cart-total">
              {total ? formatNaira(total) : "—"}
            </p>
            {catalogue.taxRatePercent !== "0.00" && (
              <p className="mt-0.5 text-xs text-muted-foreground">Prices include tax at {plainNumber(catalogue.taxRatePercent)}% where it applies.</p>
            )}
          </div>

          {tillClosed && (
            <Alert variant="destructive" data-testid="till-closed">
              The till of {terminal!.code} is not open, so nothing can be sold here yet.{" "}
              <Link href={`/till?terminal=${terminal!.id}`} className="font-medium underline underline-offset-4">
                Open the till
              </Link>
            </Alert>
          )}

          <div className="flex flex-col gap-3">
            {paid.map(({ part, isCash, amount, short, badCash }, index) => {
              const at = (field: string) => errors[`payments.${index}.${field}`];
              // The box the cursor goes to when the cashier moves on to paying.
              const first = index === 0;
              return (
                <div key={part.key} data-testid={`payment-${index + 1}`} className="flex flex-col gap-2 rounded-2xl border p-3">
                  <div className="flex items-end gap-2">
                    <div className="flex flex-1 flex-col gap-1.5">
                      <Label htmlFor={`method-${part.key}`}>{split ? `Payment ${index + 1}: paid by` : "Paid by"}</Label>
                      <NativeSelect
                        id={`method-${part.key}`}
                        value={part.methodId}
                        onChange={(event) => changePart(part.key, { methodId: event.target.value, tendered: "", reference: "" })}
                        aria-invalid={!!at("methodId")}
                      >
                        {catalogue.paymentMethods.map((method) => (
                          <option key={method.id} value={method.id}>
                            {method.name}
                          </option>
                        ))}
                      </NativeSelect>
                    </div>
                    {split && (
                      <Button type="button" variant="ghost" size="icon" onClick={() => removePart(part.key)} aria-label={`Remove payment ${index + 1}`} title="Remove this payment">
                        <X className="size-4" aria-hidden />
                      </Button>
                    )}
                  </div>
                  {at("methodId") && <p className="text-xs text-destructive">{at("methodId")}</p>}

                  {split && (
                    <div className="flex flex-col gap-1.5">
                      <Label htmlFor={`amount-${part.key}`}>Amount (₦)</Label>
                      <Input
                        id={`amount-${part.key}`}
                        ref={first ? cashBox : undefined}
                        value={part.amount}
                        onChange={(event) => changePart(part.key, { amount: event.target.value })}
                        inputMode="decimal"
                        autoComplete="off"
                        aria-invalid={!!at("amount") || (part.amount.trim() !== "" && !amount)}
                        className="text-right tabular-nums"
                      />
                      {at("amount") && <p className="text-xs text-destructive">{at("amount")}</p>}
                    </div>
                  )}

                  {isCash ? (
                    <div className="flex flex-col gap-1.5">
                      <Label htmlFor={`tendered-${part.key}`}>{split ? "Cash received (₦), if more than the amount" : "Cash received (₦)"}</Label>
                      <div className="flex gap-2">
                        <Input
                          id={`tendered-${part.key}`}
                          ref={first && !split ? cashBox : undefined}
                          value={part.tendered}
                          onChange={(event) => changePart(part.key, { tendered: event.target.value })}
                          inputMode="decimal"
                          autoComplete="off"
                          aria-invalid={!!at("tendered") || !!short || badCash}
                          className={split ? "text-right tabular-nums" : "h-12 text-right text-lg tabular-nums"}
                        />
                        {!split && (
                          <Button type="button" variant="outline" className="h-12 shrink-0" disabled={!total} onClick={() => total && changePart(part.key, { tendered: moneyToString(total) })}>
                            Exact
                          </Button>
                        )}
                      </div>
                      {at("tendered") && <p className="text-xs text-destructive">{at("tendered")}</p>}
                      {!at("tendered") && short && <p className="text-xs text-destructive">{formatNaira(short)} short.</p>}
                      {!at("tendered") && badCash && (
                        <p className="text-xs text-destructive">Enter a plain amount, for example 5000 or 5000.50 (no commas).</p>
                      )}
                    </div>
                  ) : (
                    <div className="flex flex-col gap-1.5">
                      <Label htmlFor={`reference-${part.key}`}>Reference (optional)</Label>
                      <Input
                        id={`reference-${part.key}`}
                        ref={first && !split ? cashBox : undefined}
                        value={part.reference}
                        onChange={(event) => changePart(part.key, { reference: event.target.value })}
                        autoComplete="off"
                        maxLength={60}
                        placeholder="For example the transfer or POS slip number"
                        aria-invalid={!!at("reference")}
                      />
                      {at("reference") && <p className="text-xs text-destructive">{at("reference")}</p>}
                    </div>
                  )}
                </div>
              );
            })}

            {catalogue.paymentMethods.length > parts.length && (
              <Button type="button" variant="outline" size="sm" className="w-fit" onClick={addPart}>
                <Plus className="size-4" aria-hidden /> {split ? "Add another payment" : "Split the payment"}
              </Button>
            )}
            {split && (
              <p className="flex items-baseline justify-between px-1 text-sm" data-testid="left-to-pay">
                <span className="text-muted-foreground">Left to pay</span>
                <span className={leftToPay && leftToPay.isZero() ? "font-semibold tabular-nums" : "font-semibold text-destructive tabular-nums"}>
                  {leftToPay ? formatNaira(leftToPay) : "—"}
                </span>
              </p>
            )}
            {errors.payments && <p className="text-xs text-destructive">{errors.payments}</p>}
          </div>

          {hasCash && (
            <div className="flex items-baseline justify-between rounded-2xl bg-muted px-4 py-3">
              <span className="text-sm text-muted-foreground">Change to give</span>
              <span className="text-2xl font-semibold tabular-nums" data-testid="change-due">
                {changeDue ? formatNaira(changeDue) : "—"}
              </span>
            </div>
          )}

          {message && <Alert variant="destructive">{message}</Alert>}
          {errors.expectedTotal && <Alert variant="destructive">{errors.expectedTotal}</Alert>}
          {errors.lines && <Alert variant="destructive">{errors.lines}</Alert>}
          {pricesChanged && (
            <Button type="button" variant="outline" onClick={() => router.refresh()}>
              <RefreshCw className="size-4" aria-hidden /> Get the latest prices
            </Button>
          )}

          <Button type="submit" size="lg" className="h-14 text-base" disabled={pending || !ready} data-testid="complete-sale">
            {pending ? "Saving…" : "Complete sale"}
          </Button>
          <p className="text-xs text-muted-foreground">
            Enter in the payment box completes the sale. Nothing is saved until then, and a sale is saved once however
            many times the button is pressed.
          </p>
        </CardContent>
      </Card>
    </form>
  );
}
