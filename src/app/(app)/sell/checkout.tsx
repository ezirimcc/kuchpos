"use client";

import { Pause, Play, Plus, RefreshCw, Search, Trash2, X } from "lucide-react";
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
import { formatNaira, lineTotal, moneyToString, percentOf, sumMoney } from "@/lib/money";
import type { CheckoutCatalogue, CheckoutProduct } from "@/server/business/sales";
import { quickCreateCustomerAction } from "../customers/actions";
import { approveAtScreenAction, postSaleAction, requestApprovalAction, withdrawApprovalRequestAction } from "../sales/actions";
import { ApprovalBox } from "./approval-box";
import { type HeldSale, holdSale, MAX_HELD_SALES, removeHeldSale, useHeldSales } from "./held-sales";

type CartLine = { key: string; productId: string; unitId: string; quantity: string; fromStoreroom: boolean };

/**
 * One part of how the sale is paid. With a single part its amount is the whole total and is
 * not typed; when the payment is split, each part's amount is typed.
 */
type PaymentPart = { key: string; methodId: string; amount: string; tendered: string; reference: string };

const MAX_MATCHES = 8;

const isQuantity = (text: string) => /^\d+(\.\d{1,3})?$/.test(text.trim()) && new Decimal(text.trim()).greaterThan(0);
const isMoney = (text: string) => /^\d+(\.\d{1,2})?$/.test(text.trim());
const isPercent = (text: string) => /^\d{1,3}(\.\d{1,2})?$/.test(text.trim());

/** An approval a manager gave at this screen, and exactly what it was given for. */
type Approval = { id: string; by: string; for: string };
type ApprovalKind = "DISCOUNT" | "CREDIT_OVER_LIMIT";
/** A request sent to a manager's own computer, and what has become of it. */
type SentRequest = { kind: ApprovalKind; requestId: string; for: string; state: "waiting" | "refused" | "expired"; text?: string };
const REQUEST_POLL_MS = 3000;

/**
 * The checkout. Everything on it is worked out here from the copy of the catalogue the page
 * was given — for the cashier's eyes only: the server works it all out again when the sale
 * is sent, and refuses the sale if anything differs.
 */
/** A sale exactly as it is sent to be saved: to the server, or into the waiting queue when there is no internet. */
export type SaleToSave = {
  requestId: string;
  terminalId: string;
  deviceTime: string;
  expectedTotal: string;
  customerId: string;
  payments: { methodId: string; amount: string; tendered: string; reference: string }[];
  lines: { productId: string; unitId: string; quantity: string; unitPrice: string; fromStoreroom: boolean }[];
};

/** A sale in progress carried from the online checkout to the offline one when the internet drops. */
export type CartHandover = { requestId: string; lines: Omit<CartLine, "key">[]; customerText: string };
export const HANDOVER_KEY = "kuchpos_cart_handover";

export function Checkout({
  catalogue,
  cashierId,
  offline,
  start,
}: {
  catalogue: CheckoutCatalogue;
  cashierId: string;
  /**
   * Set when this is the checkout that runs without internet: the sale is not sent to the
   * server but handed to `save`, which puts it in the waiting queue and returns a message
   * if it could not. Discounts, credit and new customers are not offered.
   */
  offline?: { save: (sale: SaleToSave) => Promise<string | null> };
  /** A sale in progress to begin with. */
  start?: CartHandover | null;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  // The sale's unique ID, made up here before anything is sent: pressing the button many
  // times, or the network repeating itself, can only ever save this sale once.
  const [requestId, setRequestId] = useState(() => start?.requestId ?? crypto.randomUUID());
  // True once the server could not be reached from this (online) checkout.
  const [noInternet, setNoInternet] = useState(false);
  const remembered = useRememberedTerminal();
  const [chosenTerminal, setChosenTerminal] = useState<string | null>(null);
  // This computer remembers which terminal it is. With one terminal there is nothing to choose;
  // with several, nothing is assumed: receipt numbers belong to the terminal, so the person
  // must say which one this computer is, once.
  const terminalId =
    [chosenTerminal, remembered].find((id) => id && catalogue.terminals.some((terminal) => terminal.id === id)) ??
    (catalogue.terminals.length === 1 ? catalogue.terminals[0].id : "");
  const [lines, setLines] = useState<CartLine[]>(() => (start?.lines ?? []).map((line) => ({ ...line, key: crypto.randomUUID() })));
  const [search, setSearch] = useState("");
  const [highlighted, setHighlighted] = useState(0);
  const [parts, setParts] = useState<PaymentPart[]>(() => [
    { key: "first", methodId: catalogue.paymentMethods[0]?.id ?? "", amount: "", tendered: "", reference: "" },
  ]);
  const [message, setMessage] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  // The customer the sale is for ("" is a walk-in), and how much of it goes on their account.
  const [customers, setCustomers] = useState(catalogue.customers);
  const [customerText, setCustomerText] = useState(start?.customerText ?? "");
  const [creditText, setCreditText] = useState("");
  const [newCustomer, setNewCustomer] = useState<{ name: string; phone: string } | null>(null);
  const [newCustomerError, setNewCustomerError] = useState<string | null>(null);
  // An extra discount on the whole sale: typed as Naira or as a percentage, with a reason.
  const [discountOpen, setDiscountOpen] = useState(false);
  const [discountText, setDiscountText] = useState("");
  const [discountAs, setDiscountAs] = useState<"naira" | "percent">("naira");
  const [discountReason, setDiscountReason] = useState("");
  const [discountApproval, setDiscountApproval] = useState<Approval | null>(null);
  const [creditApproval, setCreditApproval] = useState<Approval | null>(null);
  const [asking, setAsking] = useState<"DISCOUNT" | "CREDIT_OVER_LIMIT" | null>(null);
  const [approvalError, setApprovalError] = useState<string | null>(null);
  const [sent, setSent] = useState<SentRequest | null>(null);
  const held = useHeldSales(cashierId);
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

  const freshPayment = (): PaymentPart[] => [
    { key: crypto.randomUUID(), methodId: catalogue.paymentMethods[0]?.id ?? "", amount: "", tendered: "", reference: "" },
  ];

  function clearDiscount() {
    setDiscountOpen(false);
    setDiscountText("");
    setDiscountReason("");
    setAsking(null);
    setApprovalError(null);
    takeBack();
  }

  /** Takes back a request that is still waiting at a manager's computer. */
  function takeBack() {
    if (sent?.state === "waiting") void withdrawApprovalRequestAction(sent.requestId);
    setSent(null);
  }

  /** Parks the sale in progress so another customer can be served. Nothing is saved on the server. */
  function hold(): boolean {
    if (lines.length === 0) return true;
    const kept = holdSale(
      cashierId,
      lines.map(({ productId, unitId, quantity, fromStoreroom }) => ({ productId, unitId, quantity, fromStoreroom })),
    );
    if (!kept) {
      setMessage(`${MAX_HELD_SALES} sales are already on hold. Complete or discard one of them first.`);
      return false;
    }
    setLines([]);
    setParts(freshPayment());
    setCustomerText("");
    setCreditText("");
    clearDiscount();
    setMessage(null);
    setErrors({});
    searchBox.current?.focus();
    return true;
  }

  /** Brings a held sale back. If a sale is in progress, that one is put on hold in its place. */
  function resume(sale: HeldSale) {
    // Taken off the list first, so that there is room to hold the sale in progress.
    removeHeldSale(cashierId, sale.id);
    if (!hold()) {
      holdSale(cashierId, sale.lines);
      return;
    }
    setLines(sale.lines.map((line) => ({ ...line, key: crypto.randomUUID() })));
    setParts(freshPayment());
    searchBox.current?.focus();
  }

  /** What a held sale holds, in words and in money at today's prices. */
  function describeHeld(sale: HeldSale) {
    let total: Decimal | null = new Decimal(0);
    const items = sale.lines.map((line) => {
      const product = productById.get(line.productId);
      const unit = product?.units.find((candidate) => candidate.id === line.unitId);
      if (!product || !unit || !isQuantity(line.quantity)) {
        total = null;
        return "something no longer on sale";
      }
      if (total) total = total.plus(lineTotal(new Decimal(line.quantity.trim()), new Decimal(unit.price)));
      return `${plainNumber(line.quantity.trim())} ${unit.name} ${product.name}`;
    });
    return { items: items.join(", "), total: total as Decimal | null };
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
  const subtotal = allValid ? sumMoney(view.map((entry) => entry.amount!)) : null;

  // --- The extra discount -------------------------------------------------------------
  const discountTyped = discountOpen ? discountText.trim() : "";
  const discount =
    discountTyped === "" || !subtotal
      ? new Decimal(0)
      : discountAs === "percent"
        ? isPercent(discountTyped) && new Decimal(discountTyped).greaterThan(0) && new Decimal(discountTyped).lessThanOrEqualTo(100)
          ? percentOf(subtotal, new Decimal(discountTyped))
          : null
        : isMoney(discountTyped) && new Decimal(discountTyped).greaterThan(0) && new Decimal(discountTyped).lessThanOrEqualTo(subtotal)
          ? new Decimal(discountTyped)
          : null;
  const discounted = !!discount && discount.greaterThan(0);
  const reasonGiven = discountReason.trim().length >= 3;
  const linesKey = JSON.stringify(view.map(({ line }) => [line.productId, line.unitId, line.quantity.trim(), line.fromStoreroom]));
  // An approval counts only while the sale is still exactly what was approved.
  const discountKey = `${requestId}|${linesKey}|${discount ? moneyToString(discount) : ""}`;
  const discountApproved = discounted && discountApproval?.for === discountKey;
  const discountSound = !!discount && (!discounted || (reasonGiven && (catalogue.canApproveDiscount || discountApproved)));
  const total = subtotal && discount ? subtotal.minus(discount) : subtotal;

  // --- Who it is for, and how much goes on their account ------------------------------
  const customerLabel = (customer: { name: string; phone: string }) => `${customer.name} — ${customer.phone}`;
  const customer = customers.find((candidate) => customerLabel(candidate).toLowerCase() === customerText.trim().toLowerCase());
  const unknownCustomer = customerText.trim() !== "" && !customer;
  const owes = customer ? new Decimal(customer.balance) : null;
  const limit = customer?.creditLimit ? new Decimal(customer.creditLimit) : null;
  const room = owes && limit ? Decimal.max(limit.minus(owes), 0) : null;
  const mayCredit = catalogue.canSellOnCredit && !!customer && !!limit;
  const creditTyped = mayCredit ? creditText.trim() : "";
  const credit = creditTyped === "" ? new Decimal(0) : isMoney(creditTyped) && new Decimal(creditTyped).greaterThan(0) ? new Decimal(creditTyped) : null;
  const creditTooMuch = !!credit && !!total && credit.greaterThan(total);
  const overLimit = !!credit && !!room && credit.greaterThan(room);
  const creditKey = `${requestId}|${customer?.id ?? ""}|${credit ? moneyToString(credit) : ""}`;
  const creditApproved = overLimit && creditApproval?.for === creditKey;
  const creditSound = !!credit && !creditTooMuch && (!overLimit || catalogue.canAllowOverLimit || creditApproved);
  // What is left to pay now, after what goes on credit.
  const toPay = total && credit && !creditTooMuch ? total.minus(credit) : total;
  const nothingToPay = !!toPay && toPay.isZero() && !!credit && credit.greaterThan(0);

  function addCustomer() {
    if (!newCustomer || pending) return;
    setNewCustomerError(null);
    startTransition(async () => {
      const result = await quickCreateCustomerAction(newCustomer);
      if (result.status === "success" && result.customerId) {
        const phone = newCustomer.phone.replace(/[\s\-().]/g, "");
        const added = { id: result.customerId, name: newCustomer.name.trim(), phone, balance: "0.00", creditLimit: null };
        setCustomers((current) => [...current, added]);
        setCustomerText(customerLabel(added));
        setNewCustomer(null);
      } else if (result.status === "error") {
        setNewCustomerError(result.fieldErrors.name ?? result.fieldErrors.phone ?? result.message);
      }
    });
  }

  // --- How it is paid ----------------------------------------------------------------
  const split = parts.length > 1;
  const methodOf = (part: PaymentPart) => catalogue.paymentMethods.find((method) => method.id === part.methodId);
  const paid = parts.map((part) => {
    const method = methodOf(part);
    const isCash = method?.kind === "CASH";
    // A single payment is for the whole total; a split one is for what was typed.
    const amount = split ? (isMoney(part.amount) && new Decimal(part.amount.trim()).greaterThan(0) ? new Decimal(part.amount.trim()) : null) : toPay;
    // Cash handed over. When the payment is split it may be left empty, meaning "exactly its amount".
    const typed = part.tendered.trim();
    const received = !isCash ? null : typed === "" ? (split ? amount : null) : isMoney(typed) ? new Decimal(typed) : null;
    const short = isCash && amount && received && received.lessThan(amount) ? amount.minus(received) : null;
    const badCash = isCash && typed !== "" && !isMoney(typed);
    const sound = !!method && !!amount && (!isCash || (!!received && !short));
    return { part, method, isCash, amount, received, short, badCash, sound };
  });
  const paidSoFar = paid.every((entry) => entry.amount) ? sumMoney(paid.map((entry) => entry.amount!)) : null;
  const leftToPay = toPay && paidSoFar ? toPay.minus(paidSoFar) : null;
  const changeDue =
    total && !nothingToPay && paid.every((entry) => entry.sound)
      ? sumMoney(paid.filter((entry) => entry.isCash).map((entry) => entry.received!.minus(entry.amount!)))
      : null;
  const hasCash = !nothingToPay && paid.some((entry) => entry.isCash);
  const terminal = catalogue.terminals.find((candidate) => candidate.id === terminalId);
  const tillClosed = !!terminal && !terminal.tillOpen;
  const paymentsSound = nothingToPay || (paid.every((entry) => entry.sound) && !!leftToPay && leftToPay.isZero());
  const nothingCharged = !!total && total.isZero();
  const ready = !!total && !unknownCustomer && discountSound && creditSound && (paymentsSound || nothingCharged) && !!terminal && !tillClosed;

  const saleLines = () =>
    view.map(({ line, unit }) => ({
      productId: line.productId,
      unitId: line.unitId,
      quantity: line.quantity.trim(),
      unitPrice: unit!.price,
      fromStoreroom: line.fromStoreroom,
    }));
  const discountToSend = () => ({
    amount: moneyToString(discount!),
    percent: discountAs === "percent" ? discountTyped : "",
    reason: discountReason.trim(),
  });

  const whatIsAsked = (kind: ApprovalKind) => ({
    kind,
    saleRequestId: requestId,
    lines: saleLines(),
    ...(kind === "DISCOUNT" ? { discount: discountToSend() } : { customerId: customer?.id ?? "", creditAmount: moneyToString(credit!) }),
  });

  /** Sends the discount (or the credit) to be approved from a manager's own computer. */
  function sendForApproval(kind: ApprovalKind) {
    if (pending || !subtotal) return;
    const approvedFor = kind === "DISCOUNT" ? discountKey : creditKey;
    setApprovalError(null);
    setAsking(null);
    startTransition(async () => {
      const result = await requestApprovalAction(whatIsAsked(kind));
      if (result.status === "success" && result.requestId) {
        setSent({ kind, requestId: result.requestId, for: approvedFor, state: "waiting" });
      } else if (result.status === "error") {
        setMessage(result.message);
        setErrors(result.fieldErrors);
      }
    });
  }

  // While a request is waiting, this screen asks every few seconds what has become of it.
  const waitingFor = sent?.state === "waiting" ? sent : null;
  const waitingStillFits = !!waitingFor && waitingFor.for === (waitingFor.kind === "DISCOUNT" ? discountKey : creditKey);
  // What is shown about a request counts only while the sale is still what was sent.
  const sentNow = sent && sent.for === (sent.kind === "DISCOUNT" ? discountKey : creditKey) ? sent : null;
  useEffect(() => {
    if (!waitingFor) return;
    // The sale was changed after sending: the request is for something else now.
    if (!waitingStillFits) {
      void withdrawApprovalRequestAction(waitingFor.requestId);
      return;
    }
    let stopped = false;
    async function look() {
      try {
        const response = await fetch(`/api/approvals/requests/${waitingFor!.requestId}`, { cache: "no-store" });
        if (stopped || !response.ok) return;
        const answer = (await response.json()) as { status: string; approvalId?: string; approvedByName?: string; refusedByName?: string; note?: string | null };
        if (stopped) return;
        if (answer.status === "APPROVED" && answer.approvalId) {
          const approval = { id: answer.approvalId, by: answer.approvedByName ?? "", for: waitingFor!.for };
          if (waitingFor!.kind === "DISCOUNT") setDiscountApproval(approval);
          else setCreditApproval(approval);
          setSent(null);
        } else if (answer.status === "REFUSED") {
          setSent({ ...waitingFor!, state: "refused", text: `Refused by ${answer.refusedByName}${answer.note ? `: ${answer.note}` : "."}` });
        } else if (answer.status === "WITHDRAWN") {
          setSent(null);
        } else if (answer.status === "EXPIRED") {
          setSent({ ...waitingFor!, state: "expired", text: "Nobody answered within 10 minutes. Send it again, or ask a manager to approve here." });
        }
      } catch {
        // No connection just now; try again next time.
      }
    }
    const timer = window.setInterval(look, REQUEST_POLL_MS);
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, [waitingFor, waitingStillFits]);

  /** A manager has typed their username and password: ask the server for the approval. */
  function approve(username: string, password: string) {
    if (pending || !asking || !subtotal) return;
    const kind = asking;
    const approvedFor = kind === "DISCOUNT" ? discountKey : creditKey;
    setApprovalError(null);
    startTransition(async () => {
      const result = await approveAtScreenAction({ ...whatIsAsked(kind), username, password });
      if (result.status === "success" && result.approval) {
        const approval = { id: result.approval.id, by: result.approval.approvedByName, for: approvedFor };
        if (kind === "DISCOUNT") setDiscountApproval(approval);
        else setCreditApproval(approval);
        setAsking(null);
        if (sent?.kind === kind) takeBack();
      } else if (result.status === "error") {
        const { password: wrong, ...others } = result.fieldErrors;
        setApprovalError(wrong ?? Object.values(others)[0] ?? result.message);
        setErrors(others);
      }
    });
  }

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
    const sale: SaleToSave = {
      requestId,
      terminalId,
      deviceTime: new Date().toISOString(),
      expectedTotal: moneyToString(total),
      customerId: customer?.id ?? "",
      payments:
        nothingToPay || nothingCharged
          ? []
          : paid.map(({ part, isCash, amount }) => ({
              methodId: part.methodId,
              amount: moneyToString(amount!),
              tendered: isCash ? part.tendered.trim() : "",
              reference: isCash ? "" : part.reference.trim(),
            })),
      lines: saleLines(),
    };
    startTransition(async () => {
      if (offline) {
        const problem = await offline.save(sale);
        if (problem) {
          setMessage(problem);
          return;
        }
        // The page shows the receipt; this screen is ready for the next customer.
        setRequestId(crypto.randomUUID());
        setLines([]);
        setParts(freshPayment());
        setCustomerText("");
        return;
      }
      let result: Awaited<ReturnType<typeof postSaleAction>>;
      try {
        result = await postSaleAction({
          ...sale,
          creditAmount: credit && credit.greaterThan(0) ? moneyToString(credit) : "",
          ...(discounted ? { discount: { ...discountToSend(), approvalId: discountApproved ? discountApproval!.id : "" } } : {}),
          ...(creditApproved ? { creditApprovalId: creditApproval!.id } : {}),
        });
      } catch {
        // The server could not be reached. Nothing is known to be saved; the sale keeps its
        // ID, so carrying on without internet can never save it twice.
        setNoInternet(true);
        return;
      }
      if (result.status === "success" && result.sale) {
        setRequestId(crypto.randomUUID());
        router.push(`/sales/${result.sale.id}?sold=1`);
      } else if (result.status === "error") {
        setMessage(result.message);
        setErrors(result.fieldErrors);
      }
    });
  }

  /** Carries the sale in progress over to the checkout that works without internet. */
  function carryOnOffline() {
    const handover: CartHandover = {
      requestId,
      lines: lines.map(({ productId, unitId, quantity, fromStoreroom }) => ({ productId, unitId, quantity, fromStoreroom })),
      customerText,
    };
    try {
      window.sessionStorage.setItem(HANDOVER_KEY, JSON.stringify(handover));
    } catch {
      // Without it the cashier simply enters the sale again.
    }
    // A full page load on purpose: with no internet only the browser's kept copy of the
    // offline checkout can answer, and that is served to page loads, not to in-app moves.
    // eslint-disable-next-line @next/next/no-location-assign-relative-destination
    window.location.assign("/offline");
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
            {view.length > 0 && (
              <div className="border-t pt-3">
                <Button type="button" variant="outline" size="sm" onClick={hold} data-testid="hold-sale">
                  <Pause className="size-4" aria-hidden /> Put this sale on hold
                </Button>
              </div>
            )}
          </CardContent>
        </Card>

        {held.length > 0 && (
          <Card>
            <CardContent className="flex flex-col gap-1" data-testid="held-sales">
              <div className="pb-2">
                <h2 className="text-base font-semibold">
                  Sales on hold ({held.length})
                </h2>
                <p className="text-xs text-muted-foreground">
                  Kept on this computer for you only. Nothing is sold, and no stock is set aside, until a sale is completed.
                </p>
              </div>
              {held.map((sale, index) => {
                const { items, total: heldTotal } = describeHeld(sale);
                return (
                  <div key={sale.id} data-testid={`held-sale-${index + 1}`} className="flex flex-wrap items-center gap-3 border-t py-2.5">
                    <div className="min-w-48 flex-1">
                      <p className="text-sm font-medium">{items}</p>
                      <p className="text-xs text-muted-foreground">
                        Held at {new Date(sale.heldAt).toLocaleTimeString("en-NG", { hour: "numeric", minute: "2-digit", timeZone: "Africa/Lagos" })}
                      </p>
                    </div>
                    <p className="font-semibold tabular-nums">{heldTotal ? formatNaira(heldTotal) : "—"}</p>
                    <Button type="button" size="sm" onClick={() => resume(sale)}>
                      <Play className="size-4" aria-hidden /> Resume
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      onClick={() => removeHeldSale(cashierId, sale.id)}
                      aria-label={`Discard held sale ${index + 1}`}
                      title="Discard this held sale"
                    >
                      <Trash2 className="size-4" aria-hidden />
                    </Button>
                  </div>
                );
              })}
            </CardContent>
          </Card>
        )}
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
            {discounted && subtotal && (
              <p className="mt-0.5 text-xs text-muted-foreground" data-testid="cart-discount">
                {formatNaira(subtotal)} less a discount of {formatNaira(discount!)}
              </p>
            )}
            {catalogue.taxRatePercent !== "0.00" && (
              <p className="mt-0.5 text-xs text-muted-foreground">Prices include tax at {plainNumber(catalogue.taxRatePercent)}% where it applies.</p>
            )}
          </div>

          {tillClosed && (
            <Alert variant="destructive" data-testid="till-closed">
              The till of {terminal!.code} is not open, so nothing can be sold here yet.{" "}
              {offline ? (
                "Open it with the form above."
              ) : (
                <Link href={`/till?terminal=${terminal!.id}`} className="font-medium underline underline-offset-4">
                  Open the till
                </Link>
              )}
            </Alert>
          )}

          {catalogue.canDiscount &&
            (!discountOpen ? (
              <button
                type="button"
                onClick={() => setDiscountOpen(true)}
                className="w-fit text-xs text-link underline-offset-4 hover:underline"
                data-testid="add-discount"
              >
                + Discount
              </button>
            ) : (
              <div className="flex flex-col gap-2 rounded-2xl border p-3" data-testid="checkout-discount">
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="discount">Discount on the whole sale</Label>
                  <div className="flex gap-2">
                    <Input
                      id="discount"
                      value={discountText}
                      onChange={(event) => {
                        setDiscountText(event.target.value);
                        setErrors({});
                      }}
                      inputMode="decimal"
                      autoComplete="off"
                      aria-invalid={discount === null || !!errors["discount.amount"] || !!errors["discount.percent"]}
                      className="text-right tabular-nums"
                    />
                    <NativeSelect
                      aria-label="Discount typed as"
                      value={discountAs}
                      onChange={(event) => {
                        setDiscountAs(event.target.value === "percent" ? "percent" : "naira");
                        setErrors({});
                      }}
                      className="w-24 shrink-0"
                    >
                      <option value="naira">₦</option>
                      <option value="percent">%</option>
                    </NativeSelect>
                  </div>
                  {discount === null && (
                    <p className="text-xs text-destructive">
                      {discountAs === "percent"
                        ? "Enter a percentage above 0 and up to 100, for example 5 or 7.5."
                        : "Enter a plain amount above zero and no more than the items come to, for example 500."}
                    </p>
                  )}
                  {(errors["discount.amount"] ?? errors["discount.percent"]) && (
                    <p className="text-xs text-destructive">{errors["discount.amount"] ?? errors["discount.percent"]}</p>
                  )}
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="discount-reason">Reason for the discount</Label>
                  <Input
                    id="discount-reason"
                    value={discountReason}
                    onChange={(event) => {
                      setDiscountReason(event.target.value);
                      setErrors({});
                    }}
                    maxLength={300}
                    autoComplete="off"
                    aria-invalid={!!errors["discount.reason"]}
                  />
                  {errors["discount.reason"] && <p className="text-xs text-destructive">{errors["discount.reason"]}</p>}
                </div>
                {discounted && !catalogue.canApproveDiscount && discountApproved && (
                  <p className="text-xs font-medium text-emerald-700 dark:text-emerald-400" data-testid="discount-approved">
                    Approved by {discountApproval!.by}. Complete the sale within 10 minutes; changing the items or the discount needs a new approval.
                  </p>
                )}
                {discounted && catalogue.canApproveDiscount && (
                  <p className="text-xs text-muted-foreground">You are allowed to approve this yourself; it will be recorded under your name.</p>
                )}
                {errors["discount.approvalId"] && <p className="text-xs text-destructive">{errors["discount.approvalId"]}</p>}
                {asking === "DISCOUNT" && discounted && subtotal ? (
                  <ApprovalBox
                    what={`a discount of ${formatNaira(discount!)} on ${formatNaira(subtotal)}`}
                    busy={pending}
                    error={approvalError}
                    onApprove={approve}
                    onCancel={() => setAsking(null)}
                  />
                ) : (
                  <>
                    {sentNow?.kind === "DISCOUNT" && sentNow.state === "waiting" && (
                      <p className="text-xs font-medium" data-testid="discount-sent">
                        Sent. Waiting for a manager to approve it on their own computer…
                      </p>
                    )}
                    {sentNow?.kind === "DISCOUNT" && sentNow.state !== "waiting" && (
                      <p className="text-xs text-destructive" data-testid="discount-not-approved">
                        {sentNow.text}
                      </p>
                    )}
                    <div className="flex flex-wrap gap-2">
                      {discounted && !catalogue.canApproveDiscount && !discountApproved && (
                        <>
                          <Button
                            type="button"
                            size="sm"
                            disabled={!reasonGiven}
                            title={reasonGiven ? undefined : "Give the reason first"}
                            onClick={() => {
                              setApprovalError(null);
                              setAsking("DISCOUNT");
                            }}
                            data-testid="ask-discount-approval"
                          >
                            Approve here
                          </Button>
                          {sentNow?.kind === "DISCOUNT" && sentNow.state === "waiting" ? (
                            <Button type="button" size="sm" variant="outline" onClick={takeBack}>
                              Take the request back
                            </Button>
                          ) : (
                            <Button
                              type="button"
                              size="sm"
                              variant="outline"
                              disabled={!reasonGiven || pending}
                              title={reasonGiven ? undefined : "Give the reason first"}
                              onClick={() => sendForApproval("DISCOUNT")}
                              data-testid="send-discount-approval"
                            >
                              Send to a manager
                            </Button>
                          )}
                        </>
                      )}
                      <Button type="button" size="sm" variant="ghost" onClick={clearDiscount}>
                        No discount
                      </Button>
                    </div>
                  </>
                )}
              </div>
            ))}

          <div className="flex flex-col gap-2" data-testid="checkout-customer">
            <datalist id="checkout-customers">
              {customers.map((candidate) => (
                <option key={candidate.id} value={customerLabel(candidate)} />
              ))}
            </datalist>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="customer">Customer</Label>
              <Input
                id="customer"
                list="checkout-customers"
                value={customerText}
                onChange={(event) => {
                  setCustomerText(event.target.value);
                  setCreditText("");
                  setErrors({});
                }}
                placeholder="Walk-in — or type a name or phone"
                autoComplete="off"
                aria-invalid={unknownCustomer || !!errors.customerId}
              />
              {errors.customerId && <p className="text-xs text-destructive">{errors.customerId}</p>}
              {unknownCustomer && !errors.customerId && (
                <p className="text-xs text-destructive">Choose a customer from the list, or clear the box for a walk-in.</p>
              )}
              {customer && (
                <p className="text-xs text-muted-foreground" data-testid="customer-standing">
                  Owes {nairaFromText(customer.balance)} ·{" "}
                  {limit && room ? `limit ${formatNaira(limit)} · can still take ${formatNaira(room)} on credit` : "no credit"}
                </p>
              )}
            </div>
            {offline ? null : newCustomer === null ? (
              <button
                type="button"
                onClick={() => setNewCustomer({ name: "", phone: "" })}
                className="w-fit text-xs text-link underline-offset-4 hover:underline"
              >
                + New customer
              </button>
            ) : (
              <div className="flex flex-col gap-2 rounded-2xl border p-3">
                <Input
                  value={newCustomer.name}
                  onChange={(event) => setNewCustomer({ ...newCustomer, name: event.target.value })}
                  placeholder="Customer's name"
                  aria-label="New customer's name"
                  autoComplete="off"
                />
                <Input
                  value={newCustomer.phone}
                  onChange={(event) => setNewCustomer({ ...newCustomer, phone: event.target.value })}
                  placeholder="Phone number"
                  aria-label="New customer's phone number"
                  inputMode="tel"
                  autoComplete="off"
                />
                {newCustomerError && <p className="text-xs text-destructive">{newCustomerError}</p>}
                <div className="flex gap-2">
                  <Button type="button" size="sm" onClick={addCustomer} disabled={pending}>
                    Add customer
                  </Button>
                  <Button type="button" size="sm" variant="ghost" onClick={() => setNewCustomer(null)}>
                    Not now
                  </Button>
                </div>
              </div>
            )}

            {mayCredit && (
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="credit">Put on credit (₦)</Label>
                <div className="flex gap-2">
                  <Input
                    id="credit"
                    value={creditText}
                    onChange={(event) => {
                      setCreditText(event.target.value);
                      setErrors({});
                    }}
                    inputMode="decimal"
                    autoComplete="off"
                    aria-invalid={!creditSound || !!errors.creditAmount}
                    className="text-right tabular-nums"
                  />
                  <Button type="button" variant="outline" className="shrink-0" disabled={!total} onClick={() => total && setCreditText(moneyToString(total))}>
                    All of it
                  </Button>
                </div>
                {errors.creditAmount && <p className="text-xs text-destructive">{errors.creditAmount}</p>}
                {!errors.creditAmount && credit === null && <p className="text-xs text-destructive">Enter a plain amount greater than zero, or leave it empty.</p>}
                {!errors.creditAmount && creditTooMuch && <p className="text-xs text-destructive">No more than the total can go on credit.</p>}
                {!errors.creditAmount && overLimit && !creditTooMuch && !creditApproved && (
                  <p className={catalogue.canAllowOverLimit ? "text-xs text-muted-foreground" : "text-xs text-destructive"}>
                    {catalogue.canAllowOverLimit
                      ? "This takes the customer over their credit limit. You are allowed to let it through; it will be recorded."
                      : `Over the customer's limit: only ${formatNaira(room!)} more can go on credit. A manager or admin can allow more.`}
                  </p>
                )}
                {creditApproved && (
                  <p className="text-xs font-medium text-emerald-700 dark:text-emerald-400" data-testid="credit-approved">
                    Over the limit, allowed by {creditApproval!.by}. Complete the sale within 10 minutes.
                  </p>
                )}
                {overLimit && !creditTooMuch && !catalogue.canAllowOverLimit && !creditApproved && subtotal &&
                  (asking === "CREDIT_OVER_LIMIT" ? (
                    <ApprovalBox
                      what={`${formatNaira(credit!)} on credit for ${customer!.name}, over their limit`}
                      busy={pending}
                      error={approvalError}
                      onApprove={approve}
                      onCancel={() => setAsking(null)}
                    />
                  ) : (
                    <>
                      {sentNow?.kind === "CREDIT_OVER_LIMIT" && sentNow.state === "waiting" && (
                        <p className="text-xs font-medium" data-testid="credit-sent">
                          Sent. Waiting for a manager to approve it on their own computer…
                        </p>
                      )}
                      {sentNow?.kind === "CREDIT_OVER_LIMIT" && sentNow.state !== "waiting" && <p className="text-xs text-destructive">{sentNow.text}</p>}
                      <div className="flex flex-wrap gap-2">
                        <Button
                          type="button"
                          size="sm"
                          onClick={() => {
                            setApprovalError(null);
                            setAsking("CREDIT_OVER_LIMIT");
                          }}
                          data-testid="ask-credit-approval"
                        >
                          Approve here
                        </Button>
                        {sentNow?.kind === "CREDIT_OVER_LIMIT" && sentNow.state === "waiting" ? (
                          <Button type="button" size="sm" variant="outline" onClick={takeBack}>
                            Take the request back
                          </Button>
                        ) : (
                          <Button type="button" size="sm" variant="outline" disabled={pending} onClick={() => sendForApproval("CREDIT_OVER_LIMIT")} data-testid="send-credit-approval">
                            Send to a manager
                          </Button>
                        )}
                      </div>
                    </>
                  ))}
                {credit && credit.greaterThan(0) && toPay && !creditTooMuch && (
                  <p className="text-xs text-muted-foreground" data-testid="to-pay-now">
                    To pay now: {formatNaira(toPay)}
                  </p>
                )}
              </div>
            )}
            {!mayCredit && errors.creditAmount && <p className="text-xs text-destructive">{errors.creditAmount}</p>}
          </div>

          <div className={nothingToPay || nothingCharged ? "hidden" : "flex flex-col gap-3"}>
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
                          <Button type="button" variant="outline" className="h-12 shrink-0" disabled={!toPay} onClick={() => toPay && changePart(part.key, { tendered: moneyToString(toPay) })}>
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
          {noInternet && !offline && (
            <Alert variant="destructive" data-testid="no-internet">
              The server cannot be reached, so this sale has not been saved. If the internet is down you can carry on
              selling without it; the sale in progress comes with you.
              <span className="mt-2 flex flex-wrap gap-2">
                <Button type="button" size="sm" onClick={carryOnOffline} data-testid="carry-on-offline">
                  Carry on without internet
                </Button>
                <Button type="button" size="sm" variant="outline" onClick={() => setNoInternet(false)}>
                  Try again
                </Button>
              </span>
            </Alert>
          )}
          {pricesChanged && !offline && (
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
