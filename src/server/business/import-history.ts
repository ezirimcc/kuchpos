import "server-only";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { Prisma } from "@/generated/prisma/client";
import { Decimal } from "@/lib/decimal";
import { dayToDate, formatDay, receiptNumber as deliveryNumber, shopDayStart, shopToday } from "@/lib/format";
import { DELIVERIES_SHEET, SALES_SHEET } from "@/lib/import-template";
import { formatNaira, lineTotal, moneyToString, parseMoney, roundMoney, sumMoney } from "@/lib/money";
import { parseQuantity, quantityToString, toBaseQuantity } from "@/lib/quantity";
import { activityRow } from "@/server/activity";
import type { AppContext } from "@/server/auth/context";
import { parseInput } from "@/server/auth/users";
import { importNumber } from "@/server/business/imports";
import { businessDb, businessIdOf } from "@/server/db/scoped";
import { takeDocumentNumber } from "@/server/document-number";
import { ValidationError } from "@/server/errors";
import { authorize } from "@/server/permissions";
import type { CheckedLine } from "@/server/receipt-lines";
import { writeGoodsReceipt } from "@/server/receipt-write";
import type { CheckedSaleLine } from "@/server/sale-lines";
import { type CheckedPayment, writeSale } from "@/server/sale-write";
import { cellDay, cellMinutes, cellText, type Problem, readWorkbook, rowsOf } from "@/server/workbook";

/**
 * The HISTORY part of bringing a shop's records in from Excel (SPEC §4.8, C66): the
 * deliveries received and the sales made between the starting day and today, typed on the
 * sheets Deliveries and Sales. (Products, customers and the stock counted on the starting
 * day are the SETUP part, `imports.ts`, and must be in first.)
 *
 * The rules:
 * - The two sheets are checked WHOLE before anything is saved, every problem is reported by
 *   sheet and row, and it is all saved in one transaction or not at all. The same file
 *   cannot be brought in twice; nor can a delivery reference (from the same supplier) or a
 *   receipt number that is already in KuchPos.
 * - Everything is replayed in the order it happened — by day; within a day the deliveries
 *   first, then the sales by their time — so each sale leaves at the average cost of its moment.
 * - A delivery is written by `writeGoodsReceipt` and a sale by `writeSale`: the same writers
 *   as the screens use. Nothing here is a second copy of how stock or money is recorded.
 * - An imported sale keeps its own date and time, its own receipt number with "IMP-" in
 *   front, and the price that was really charged. It belongs to no till session, so its
 *   money is in the collections report but in no till's expected cash. It needs no approval
 *   for a discount or for credit over the limit: those were given before KuchPos.
 * - If the records show more sold than the stock allows, the sale is still accepted: stock
 *   goes to zero, never below, and the rest is listed as an exception for a manager — the
 *   same rule as for sales made without internet.
 * - All goods come onto, and leave from, the Shelf.
 */

const MAX_MONEY = new Decimal("99999999999.99");
const MAX_QUANTITY = new Decimal("9999999.999");
const MAX_PROBLEMS_SHOWN = 200;
/** `sale.sequence` is unique per terminal; imported sales have a series of their own, far from the others. */
const IMPORTED_SEQUENCE_BASE = 2_000_000_000;
/** In front of the shop's own receipt number. A receipt number holds 20 characters. */
const RECEIPT_PREFIX = "IMP-";
const MAX_RECEIPT_LENGTH = 16;
/** A sale with no time typed is taken to have been made at midday. */
const MIDDAY_MINUTES = 12 * 60;
const MAX_ATTEMPTS = 3;
/**
 * The most rows of deliveries and sales in one file. Measured on a large sample (M16):
 * 9,000 rows took over a minute on a fast computer, and the hosting server is slower and
 * gives each request a limited time. A file over the limit is refused before anything is
 * read into the database; nothing is lost, it only has to be split by date.
 */
const MAX_ROWS_A_FILE = 6_000;
const SOLD_BY_UNKNOWN = "Brought in from Excel";

const inputSchema = z.object({
  fileName: z.string().trim().min(1).max(200),
  /** The day the shop's records start: "YYYY-MM-DD". Nothing in the file may be earlier. */
  startingDay: z.string().trim(),
});

export type HistoryPreview = {
  fileName: string;
  startingDay: string;
  deliveries: number;
  deliveryLines: number;
  deliveriesCost: string;
  newSuppliers: number;
  sales: number;
  saleLines: number;
  salesTotal: string;
  discountTotal: string;
  creditTotal: string;
  /** Sales that take more out of stock than the records allow. They are accepted and listed as exceptions. */
  salesShortOfStock: number;
  /** The first and last day found in the file. */
  firstDay: string | null;
  lastDay: string | null;
  problems: Problem[];
  problemCount: number;
  alreadyImported: { number: number; at: Date; byName: string } | null;
  canImport: boolean;
};

type KnownUnit = { id: string; name: string; factor: Decimal };
type KnownProduct = {
  id: string;
  name: string;
  allowsFraction: boolean;
  taxable: boolean;
  tracksBatch: boolean;
  tracksExpiry: boolean;
  baseUnitName: string;
  units: Map<string, KnownUnit>;
};
type Delivery = {
  kind: "delivery";
  row: number;
  at: Date;
  day: string;
  reference: string;
  supplierName: string;
  note: string | null;
  lines: CheckedLine[];
};
type ImportedSale = {
  kind: "sale";
  row: number;
  at: Date;
  day: string;
  receipt: string;
  soldBy: string;
  customer: { id: string; name: string; phone: string } | null;
  lines: Omit<CheckedSaleLine, "location">[];
  subtotal: Decimal;
  discount: Decimal;
  total: Decimal;
  credit: Decimal;
  method: { id: string; name: string; kind: CheckedPayment["method"]["kind"] } | null;
};
type Checked = { preview: HistoryPreview; fileHash: string; events: (Delivery | ImportedSale)[] };

const key = (text: string) => text.trim().toLowerCase();
const count = (number: number, one: string, many: string) => `${number.toLocaleString("en-NG")} ${number === 1 ? one : many}`;

async function checkHistory(context: AppContext, input: unknown, bytes: Buffer): Promise<Checked> {
  const data = parseInput(inputSchema, input);
  const db = businessDb(context);
  const problems: Problem[] = [];
  const say = (sheet: string, row: number | null, message: string) => problems.push({ sheet, row, message });

  const today = shopToday();
  const now = new Date();
  if (!dayToDate(data.startingDay)) throw new ValidationError("Choose the starting day.", { startingDay: "Choose a real date." });
  if (data.startingDay > today) throw new ValidationError("The starting day cannot be in the future.", { startingDay: "Not in the future." });

  const fileHash = createHash("sha256").update(bytes).digest("hex");
  const workbook = await readWorkbook(bytes);
  const deliveryRows = rowsOf(workbook, DELIVERIES_SHEET, problems);
  const saleRows = rowsOf(workbook, SALES_SHEET, problems);
  if (deliveryRows.length + saleRows.length > MAX_ROWS_A_FILE) {
    throw new ValidationError(
      `This file has ${(deliveryRows.length + saleRows.length).toLocaleString("en-NG")} rows of deliveries and sales. Bring in at most ${MAX_ROWS_A_FILE.toLocaleString("en-NG")} rows at a time: ` +
        "split it into several files by date (for example a week or two to a file) and bring them in one after another, the earliest first.",
    );
  }
  if (deliveryRows.length + saleRows.length === 0) {
    throw new ValidationError("Nothing to bring in: the Deliveries and Sales sheets have no rows from row 4 down. Rows 1 to 3 (headings, notes, example) are never imported.");
  }

  const references = [...new Set(deliveryRows.map(({ cells }) => cellText(cells.reference)).filter(Boolean))];
  const receipts = [...new Set(saleRows.map(({ cells }) => `${RECEIPT_PREFIX}${cellText(cells.receipt)}`))];
  const [products, customers, methods, suppliers, deliveriesThere, salesThere, shelf, shelfStock, before] = await Promise.all([
    db.product.findMany({
      select: {
        id: true,
        name: true,
        code: true,
        allowsFraction: true,
        taxable: true,
        tracksBatch: true,
        tracksExpiry: true,
        // A unit taken out of use since is still accepted: the sale or delivery happened. One in use comes first.
        units: { orderBy: { retiredAt: "desc" }, select: { id: true, name: true, factor: true, isBase: true, retiredAt: true } },
      },
    }),
    db.customer.findMany({ select: { id: true, name: true, phone: true } }),
    db.paymentMethod.findMany({ orderBy: { name: "asc" }, select: { id: true, name: true, kind: true } }),
    db.supplier.findMany({ select: { name: true } }),
    references.length > 0 ? db.goodsReceipt.findMany({ where: { invoiceNumber: { in: references } }, select: { number: true, invoiceNumber: true, supplierName: true } }) : [],
    receipts.length > 0 ? db.sale.findMany({ where: { receiptNumber: { in: receipts } }, select: { receiptNumber: true } }) : [],
    db.location.findFirst({ where: { kind: "SHELF" }, select: { id: true } }),
    db.stockBalance.findMany({ where: { location: { kind: "SHELF" } }, select: { productId: true, quantity: true } }),
    db.importRun.findFirst({ where: { part: "HISTORY", fileHash }, select: { number: true, createdAt: true, createdByName: true } }),
  ]);
  if (!shelf) throw new ValidationError("This business has no Shelf for the goods. Ask the owner to check its locations.");

  const productByCode = new Map<string, KnownProduct>();
  for (const product of products) {
    if (!product.code) continue;
    const units = new Map<string, KnownUnit>();
    // In use first (retiredAt is empty), so a name used again after a unit was retired means the one in use.
    for (const unit of [...product.units].sort((a, b) => Number(a.retiredAt !== null) - Number(b.retiredAt !== null) || a.factor.comparedTo(b.factor))) {
      if (!units.has(key(unit.name))) units.set(key(unit.name), { id: unit.id, name: unit.name, factor: new Decimal(unit.factor.toFixed(3)) });
    }
    productByCode.set(key(product.code), {
      id: product.id,
      name: product.name,
      allowsFraction: product.allowsFraction,
      taxable: product.taxable,
      tracksBatch: product.tracksBatch,
      tracksExpiry: product.tracksExpiry,
      baseUnitName: product.units.find((unit) => unit.isBase)?.name ?? "",
      units,
    });
  }
  const customerByPhone = new Map(customers.map((customer) => [customer.phone, customer]));
  const methodByName = new Map(methods.map((method) => [key(method.name), method]));
  const supplierNames = new Set(suppliers.map((supplier) => key(supplier.name)));

  const money = (sheet: string, row: number, label: string, text: string): Decimal | null => {
    try {
      const amount = parseMoney(text);
      if (amount.isNegative() || amount.greaterThan(MAX_MONEY)) throw new Error("out of range");
      return amount;
    } catch {
      say(sheet, row, `${label} "${text}" is not a plain amount. Type it as a number such as 1250 or 1250.50, with no commas or ₦ sign.`);
      return null;
    }
  };
  /** The day of a row, which must lie between the starting day and today. */
  const dayOf = (sheet: string, row: number, cell: Parameters<typeof cellDay>[0]): string | null => {
    const day = cellDay(cell);
    if (!day) {
      say(sheet, row, `The date "${cellText(cell)}" is not a date. Type it as day/month/year, for example 03/10/2026.`);
      return null;
    }
    if (day < data.startingDay) {
      say(sheet, row, `The date ${formatDay(day)} is before the day the records start (${formatDay(data.startingDay)}).`);
      return null;
    }
    if (day > today) {
      say(sheet, row, `The date ${formatDay(day)} is in the future.`);
      return null;
    }
    return day;
  };
  /** The product, unit and quantity of a row: shared by both sheets. */
  const goodsOf = (sheet: string, row: number, cells: { code: Parameters<typeof cellText>[0]; unit: Parameters<typeof cellText>[0]; quantity: Parameters<typeof cellText>[0] }) => {
    const code = cellText(cells.code);
    const unitName = cellText(cells.unit);
    const product = productByCode.get(key(code));
    if (!product) {
      say(sheet, row, `The product code "${code}" is not in KuchPos. Bring the Products sheet in first (step 2 on this page).`);
      return null;
    }
    const unit = product.units.get(key(unitName));
    if (!unit) {
      say(sheet, row, `"${product.name}" has no unit called "${unitName}". Its units are: ${[...product.units.values()].map((entry) => entry.name).join(", ")}.`);
      return null;
    }
    let quantity: Decimal;
    try {
      quantity = parseQuantity(cellText(cells.quantity));
      if (!quantity.greaterThan(0) || quantity.greaterThan(MAX_QUANTITY)) throw new Error("out of range");
    } catch {
      say(sheet, row, `The quantity "${cellText(cells.quantity)}" must be a number above zero.`);
      return null;
    }
    if (!product.allowsFraction && !quantity.isInteger()) {
      say(sheet, row, `"${product.name}" is counted in whole units; ${cellText(cells.quantity)} is not a whole number.`);
      return null;
    }
    return { product, unit, quantity };
  };

  // --- Deliveries: rows are gathered by their reference --------------------------------
  const D = DELIVERIES_SHEET.name;
  const deliveries = new Map<string, Delivery & { sound: boolean }>();
  for (const { row, cells } of deliveryRows) {
    const reference = cellText(cells.reference);
    const supplierName = cellText(cells.supplier).replace(/\s+/g, " ");
    if (!reference || !supplierName || !cellText(cells.date) || !cellText(cells.code) || !cellText(cells.unit) || cellText(cells.quantity) === "" || cellText(cells.cost) === "") {
      say(D, row, "Delivery date, Delivery reference, Supplier, Product code, Unit, Quantity and Cost per unit must all be filled in.");
      if (reference && deliveries.has(key(reference))) deliveries.get(key(reference))!.sound = false;
      continue;
    }
    if (reference.length > 60) {
      say(D, row, "The delivery reference is too long (60 characters at most).");
      continue;
    }
    if (supplierName.length < 2 || supplierName.length > 120) {
      say(D, row, "The supplier's name must be between 2 and 120 characters.");
      continue;
    }
    let delivery = deliveries.get(key(reference));
    const day = dayOf(D, row, cells.date);
    const note = cellText(cells.note);
    if (note.length > 300) say(D, row, "The note is too long (300 characters at most).");
    if (!delivery) {
      const there = deliveriesThere.find((saved) => key(saved.invoiceNumber ?? "") === key(reference) && key(saved.supplierName) === key(supplierName));
      if (there) say(D, row, `Delivery "${reference}" from ${there.supplierName} is already in KuchPos, as ${deliveryNumber(there.number)}. Take its rows out.`);
      delivery = { kind: "delivery", row, at: day ? shopDayStart(day)! : now, day: day ?? "", reference, supplierName, note: note.slice(0, 300) || null, lines: [], sound: !!day && !there };
      deliveries.set(key(reference), delivery);
    } else {
      if (day && delivery.day && day !== delivery.day) {
        say(D, row, `Delivery "${reference}" is dated ${formatDay(delivery.day)} on row ${delivery.row} and ${formatDay(day)} here. One delivery has one date; use another reference for another delivery.`);
        delivery.sound = false;
      }
      if (key(supplierName) !== key(delivery.supplierName)) {
        say(D, row, `Delivery "${reference}" is from "${delivery.supplierName}" on row ${delivery.row} and from "${supplierName}" here. Use another reference for another supplier's delivery.`);
        delivery.sound = false;
      }
    }
    if (!day) delivery.sound = false;
    const goods = goodsOf(D, row, cells);
    const unitCost = money(D, row, "The cost per unit", cellText(cells.cost));
    const batch = cellText(cells.batch);
    const expiryGiven = cellText(cells.expiry) !== "";
    const expiryDay = expiryGiven ? cellDay(cells.expiry) : null;
    let sound = !!goods && unitCost !== null;
    if (expiryGiven && !expiryDay) {
      say(D, row, `The expiry date "${cellText(cells.expiry)}" is not a date. Type it as day/month/year, for example 31/03/2027.`);
      sound = false;
    }
    if (batch.length > 60) {
      say(D, row, "The batch is too long (60 characters at most).");
      sound = false;
    }
    if (goods?.product.tracksBatch && batch === "") {
      say(D, row, `"${goods.product.name}" has batch numbers, so the batch must be filled in.`);
      sound = false;
    }
    if (goods?.product.tracksExpiry && !expiryDay) {
      say(D, row, `"${goods.product.name}" has expiry dates, so the expiry date must be filled in.`);
      sound = false;
    }
    if (!sound || !goods || unitCost === null) {
      delivery.sound = false;
      continue;
    }
    delivery.lines.push({
      productId: goods.product.id,
      productUnitId: goods.unit.id,
      productName: goods.product.name,
      unitName: goods.unit.name,
      unitFactor: quantityToString(goods.unit.factor),
      quantity: quantityToString(goods.quantity),
      baseQuantity: toBaseQuantity(goods.quantity, goods.unit.factor),
      unitCost: moneyToString(unitCost),
      lineCost: roundMoney(goods.quantity.times(unitCost)),
      batchNumber: goods.product.tracksBatch ? batch || null : null,
      expiryDate: goods.product.tracksExpiry && expiryDay ? dayToDate(expiryDay) : null,
    });
  }

  // --- Sales: rows are gathered by their receipt number ---------------------------------
  const S = SALES_SHEET.name;
  type Draft = ImportedSale & { sound: boolean; paidBy: string; phone: string; discountText: string; creditText: string };
  const sales = new Map<string, Draft>();
  for (const { row, cells } of saleRows) {
    const receipt = cellText(cells.receipt);
    if (!receipt || !cellText(cells.date) || !cellText(cells.code) || !cellText(cells.unit) || cellText(cells.quantity) === "" || cellText(cells.price) === "" || !cellText(cells.paidBy)) {
      say(S, row, "Date, Receipt number, Product code, Unit, Quantity, Price per unit and Paid by must all be filled in.");
      if (receipt && sales.has(key(receipt))) sales.get(key(receipt))!.sound = false;
      continue;
    }
    if (receipt.length > MAX_RECEIPT_LENGTH) {
      say(S, row, `The receipt number "${receipt}" is too long (${MAX_RECEIPT_LENGTH} characters at most).`);
      continue;
    }
    const day = dayOf(S, row, cells.date);
    const timeGiven = cellText(cells.time) !== "" || cells.time instanceof Date;
    const minutes = timeGiven ? cellMinutes(cells.time) : MIDDAY_MINUTES;
    const paidBy = cellText(cells.paidBy);
    const phone = cellText(cells.customerPhone).replace(/[\s\-().]/g, "");
    const discountText = cellText(cells.discount);
    const creditText = cellText(cells.onCredit);
    let sale = sales.get(key(receipt));
    if (!sale) {
      let sound = !!day;
      if (salesThere.some((saved) => key(saved.receiptNumber) === key(`${RECEIPT_PREFIX}${receipt}`))) {
        say(S, row, `Receipt ${receipt} is already in KuchPos, as ${RECEIPT_PREFIX}${receipt}. Take its rows out.`);
        sound = false;
      }
      if (minutes === null) {
        say(S, row, `The time "${cellText(cells.time)}" is not a time. Type it as hour:minute on the 24-hour clock, for example 14:35, or leave it empty.`);
        sound = false;
      }
      const at = day ? new Date(shopDayStart(day)!.getTime() + (minutes ?? MIDDAY_MINUTES) * 60_000) : now;
      if (day && at.getTime() > now.getTime()) {
        // Only a time typed for today can be ahead of the clock; a sale without a time is put at midday at the latest "now".
        if (timeGiven) {
          say(S, row, `The time ${cellText(cells.time)} today has not come yet.`);
          sound = false;
        }
      }
      const customer = phone ? (customerByPhone.get(phone) ?? null) : null;
      if (phone && !customer) {
        say(S, row, `No customer in KuchPos has the phone number "${cellText(cells.customerPhone)}". Bring the Customers sheet in first, or leave the phone empty for a walk-in.`);
        sound = false;
      }
      const soldBy = cellText(cells.soldBy).replace(/\s+/g, " ");
      if (soldBy.length > 100) {
        say(S, row, "The name under Sold by is too long (100 characters at most).");
        sound = false;
      }
      sale = {
        kind: "sale",
        row,
        at: at.getTime() > now.getTime() ? now : at,
        day: day ?? "",
        receipt,
        soldBy: soldBy.slice(0, 100),
        customer,
        lines: [],
        subtotal: new Decimal(0),
        discount: new Decimal(0),
        total: new Decimal(0),
        credit: new Decimal(0),
        method: null,
        sound,
        paidBy,
        phone,
        discountText,
        creditText,
      };
      sales.set(key(receipt), sale);
    } else {
      // One sale has one date, one way of paying and one customer. What is typed once on the
      // first row may be repeated on the others, but may not differ.
      const first = `row ${sale.row}`;
      if (day && sale.day && day !== sale.day) {
        say(S, row, `Receipt ${receipt} is dated ${formatDay(sale.day)} on ${first} and ${formatDay(day)} here. One receipt is one sale on one day.`);
        sale.sound = false;
      }
      if (!day) sale.sound = false;
      if (key(paidBy) !== key(sale.paidBy)) {
        say(S, row, `Receipt ${receipt} is paid by "${sale.paidBy}" on ${first} and by "${paidBy}" here. Put one way of paying on every row of a sale.`);
        sale.sound = false;
      }
      if (phone && phone !== sale.phone) {
        say(S, row, `Receipt ${receipt} has a different customer phone here than on ${first}.`);
        sale.sound = false;
      }
      if (discountText && discountText !== sale.discountText) {
        say(S, row, `The discount on the whole sale goes on the first row of receipt ${receipt} only (${first}).`);
        sale.sound = false;
      }
      if (creditText && creditText !== sale.creditText) {
        say(S, row, `The amount on credit goes on the first row of receipt ${receipt} only (${first}).`);
        sale.sound = false;
      }
    }
    const goods = goodsOf(S, row, cells);
    const unitPrice = money(S, row, "The price per unit", cellText(cells.price));
    if (!goods || unitPrice === null) {
      sale.sound = false;
      continue;
    }
    sale.lines.push({
      index: sale.lines.length,
      productId: goods.product.id,
      productUnitId: goods.unit.id,
      productName: goods.product.name,
      baseUnitName: goods.product.baseUnitName || goods.unit.name,
      unitName: goods.unit.name,
      unitFactor: quantityToString(goods.unit.factor),
      quantity: quantityToString(goods.quantity),
      baseQuantity: toBaseQuantity(goods.quantity, goods.unit.factor),
      unitPrice,
      lineTotal: lineTotal(goods.quantity, unitPrice),
      taxable: goods.product.taxable,
    });
  }
  // Each sale as a whole: its discount, what went on credit, and how the rest was paid.
  for (const sale of sales.values()) {
    if (!sale.sound) continue;
    sale.subtotal = sumMoney(sale.lines.map((line) => line.lineTotal));
    if (sale.discountText) {
      const discount = money(S, sale.row, "The discount", sale.discountText);
      if (discount === null) sale.sound = false;
      else if (discount.greaterThan(sale.subtotal)) {
        say(S, sale.row, `The discount of ${formatNaira(discount)} is more than receipt ${sale.receipt} comes to (${formatNaira(sale.subtotal)}).`);
        sale.sound = false;
      } else sale.discount = discount;
    }
    sale.total = sale.subtotal.minus(sale.discount);
    if (sale.creditText) {
      const credit = money(S, sale.row, "The amount on credit", sale.creditText);
      if (credit === null) sale.sound = false;
      else if (credit.greaterThan(0) && !sale.customer) {
        say(S, sale.row, `Receipt ${sale.receipt} has an amount on credit but no customer phone. Credit is always owed by a customer.`);
        sale.sound = false;
      } else if (credit.greaterThan(sale.total)) {
        say(S, sale.row, `The amount on credit, ${formatNaira(credit)}, is more than receipt ${sale.receipt} comes to (${formatNaira(sale.total)}).`);
        sale.sound = false;
      } else sale.credit = credit;
    }
    const method = methodByName.get(key(sale.paidBy));
    if (!method) {
      say(S, sale.row, `"${sale.paidBy}" is not one of this shop's ways of paying. They are: ${methods.map((entry) => entry.name).join(", ")}. Add it in Settings first, or use one of these.`);
      sale.sound = false;
    } else sale.method = method;
  }

  const soundDeliveries = [...deliveries.values()].filter((delivery) => delivery.sound && delivery.lines.length > 0);
  const soundSales = [...sales.values()].filter((sale) => sale.sound && sale.lines.length > 0);
  // In the order things happened: by moment; a delivery (start of its day) before that day's sales.
  const events: (Delivery | ImportedSale)[] = [...soundDeliveries, ...soundSales].sort(
    (a, b) => a.at.getTime() - b.at.getTime() || (a.kind === b.kind ? a.row - b.row : a.kind === "delivery" ? -1 : 1),
  );

  // How many sales the stock on record cannot cover: worked out on paper, from what the Shelf holds now.
  let salesShortOfStock = 0;
  if (problems.length === 0) {
    const held = new Map<string, Decimal>();
    for (const balance of shelfStock) held.set(balance.productId, new Decimal(balance.quantity.toFixed(3)));
    for (const event of events) {
      let short = false;
      for (const line of event.lines) {
        const there = held.get(line.productId) ?? new Decimal(0);
        if (event.kind === "delivery") held.set(line.productId, there.plus(line.baseQuantity));
        else {
          if (there.lessThan(line.baseQuantity)) short = true;
          held.set(line.productId, Decimal.max(there.minus(line.baseQuantity), 0));
        }
      }
      if (short) salesShortOfStock += 1;
    }
  }

  const days = events.map((event) => event.day).sort();
  const newSuppliers = new Set(soundDeliveries.map((delivery) => key(delivery.supplierName)).filter((name) => !supplierNames.has(name))).size;
  problems.sort((a, b) => a.sheet.localeCompare(b.sheet) || (a.row ?? 0) - (b.row ?? 0));
  return {
    fileHash,
    events,
    preview: {
      fileName: data.fileName,
      startingDay: data.startingDay,
      deliveries: soundDeliveries.length,
      deliveryLines: soundDeliveries.reduce((sum, delivery) => sum + delivery.lines.length, 0),
      deliveriesCost: moneyToString(sumMoney(soundDeliveries.flatMap((delivery) => delivery.lines.map((line) => line.lineCost)))),
      newSuppliers,
      sales: soundSales.length,
      saleLines: soundSales.reduce((sum, sale) => sum + sale.lines.length, 0),
      salesTotal: moneyToString(sumMoney(soundSales.map((sale) => sale.total))),
      discountTotal: moneyToString(sumMoney(soundSales.map((sale) => sale.discount))),
      creditTotal: moneyToString(sumMoney(soundSales.map((sale) => sale.credit))),
      salesShortOfStock,
      firstDay: days[0] ?? null,
      lastDay: days[days.length - 1] ?? null,
      problems: problems.slice(0, MAX_PROBLEMS_SHOWN),
      problemCount: problems.length,
      alreadyImported: before ? { number: before.number, at: before.createdAt, byName: before.createdByName } : null,
      canImport: problems.length === 0 && !before,
    },
  };
}

/** Reads the Deliveries and Sales sheets and says what would be brought in and what is wrong. Saves nothing. */
export async function previewHistoryImport(context: AppContext, input: unknown, bytes: Buffer): Promise<HistoryPreview> {
  authorize(context, "import.run");
  return (await checkHistory(context, input, bytes)).preview;
}

export type HistoryResult = { id: string; number: number; exceptions: number; preview: HistoryPreview };

/**
 * Brings in every delivery and sale on the two sheets, in the order they happened — all of
 * it, or none of it. Refused if the sheets have any problem, or if this exact file was
 * brought in before.
 */
export async function runHistoryImport(context: AppContext, input: unknown, bytes: Buffer): Promise<HistoryResult> {
  authorize(context, "import.run");
  const businessId = businessIdOf(context);
  const checked = await checkHistory(context, input, bytes);
  const { preview, events } = checked;
  if (preview.alreadyImported) {
    throw new ValidationError(
      `Nothing was brought in: this exact file was already brought in as ${importNumber(preview.alreadyImported.number)} by ${preview.alreadyImported.byName}. ` +
        "For later deliveries and sales, upload a file that holds only those.",
    );
  }
  if (preview.problemCount > 0) {
    throw new ValidationError(`Nothing was brought in: the workbook has ${preview.problemCount === 1 ? "a problem" : `${preview.problemCount} problems`}. Correct them in Excel and upload it again.`);
  }
  const db = businessDb(context);
  const today = shopToday();
  const who = { userId: context.actor.userId, name: context.actor.name };
  const productIds = [...new Set(events.flatMap((event) => event.lines.map((line) => line.productId)))].sort();
  const customerIds = [...new Set(events.flatMap((event) => (event.kind === "sale" && event.customer && event.credit.greaterThan(0) ? [event.customer.id] : [])))].sort();

  const save = () =>
    db.$transaction(
      async (tx) => {
        const number = await takeDocumentNumber(tx, businessId, "IMPORT");
        const label = importNumber(number);
        // Written first: the unique fingerprint is what stops the same file going in twice at once.
        const run = await tx.importRun.create({
          data: {
            businessId,
            number,
            part: "HISTORY",
            fileHash: checked.fileHash,
            fileName: preview.fileName,
            startingDay: dayToDate(preview.startingDay),
            summary: JSON.stringify({
              deliveries: preview.deliveries,
              deliveryLines: preview.deliveryLines,
              deliveriesCost: preview.deliveriesCost,
              sales: preview.sales,
              saleLines: preview.saleLines,
              salesTotal: preview.salesTotal,
              creditTotal: preview.creditTotal,
              firstDay: preview.firstDay ?? "",
              lastDay: preview.lastDay ?? "",
            }),
            createdByUserId: who.userId,
            createdByName: who.name,
          },
        });

        // Everything this import will change is taken ONCE, at the start, in the order every
        // other stock transaction uses — the terminal, customers, then products — so that a
        // sale being saved at the same moment waits for the import (or the import for it)
        // instead of the two blocking each other. (The delivery counter cannot be held ahead
        // of time; a delivery saved at the same moment can still collide, and then one of the
        // two is undone by the database and tried again.)
        const terminals = await tx.terminal.findMany({ orderBy: { code: "asc" }, select: { id: true, code: true, deactivatedAt: true } });
        const terminal = terminals.find((entry) => !entry.deactivatedAt) ?? terminals[0];
        const hasSales = events.some((event) => event.kind === "sale");
        if (hasSales && !terminal) throw new ValidationError("This business has no checkout terminal to file the sales under. Add one in Settings first.");
        if (hasSales) await tx.terminal.update({ where: { id: terminal.id }, data: { updatedAt: new Date() }, select: { id: true } });
        for (const customerId of customerIds) await tx.customer.update({ where: { id: customerId }, data: { updatedAt: new Date() }, select: { id: true } });
        for (const productId of productIds) await tx.product.update({ where: { id: productId }, data: { updatedAt: new Date() }, select: { id: true } });

        const shelf = await tx.location.findFirst({ where: { kind: "SHELF" }, select: { id: true, name: true } });
        if (!shelf) throw new ValidationError("This business has no Shelf for the goods. Ask the owner to check its locations.");
        const locationName = new Map([[shelf.id, shelf.name]]);
        const business = await tx.business.findFirst({ select: { taxRatePercent: true } });
        const taxRate = new Decimal(business?.taxRatePercent.toFixed(2) ?? "0");
        const suppliers = new Map((await tx.supplier.findMany({ select: { id: true, name: true } })).map((supplier) => [key(supplier.name), supplier]));

        let exceptions = 0;
        for (const event of events) {
          if (event.kind === "delivery") {
            let supplier = suppliers.get(key(event.supplierName));
            if (!supplier) {
              supplier = await tx.supplier.create({ data: { businessId, name: event.supplierName }, select: { id: true, name: true } });
              suppliers.set(key(supplier.name), supplier);
            }
            await writeGoodsReceipt(tx, context, {
              requestId: randomUUID(),
              supplier,
              location: shelf,
              receivedOn: event.day,
              backdated: event.day < today,
              backdateNote: event.day < today ? `Received on ${formatDay(event.day)}, brought in from Excel (${label}).` : null,
              invoiceNumber: event.reference,
              note: event.note,
              lines: event.lines,
              imported: { movementType: "RECEIPT", at: event.at, label: `delivery ${event.reference} from ${supplier.name} (${label})` },
            });
            continue;
          }

          const sequence = IMPORTED_SEQUENCE_BASE + (await takeDocumentNumber(tx, businessId, "IMPORTED_SALE"));
          // Credit: the customer's balance goes up first, as at the checkout. The limit is not
          // looked at: the shop gave this credit before KuchPos.
          let owedAfter: Decimal | null = null;
          if (event.customer && event.credit.greaterThan(0)) {
            const account = await tx.customer.update({
              where: { id: event.customer.id },
              data: { balance: { increment: moneyToString(event.credit) } },
              select: { balance: true },
            });
            owedAfter = new Decimal(account.balance.toFixed(2));
          }
          const paid = event.total.minus(event.credit);
          const payments: CheckedPayment[] =
            paid.greaterThan(0) && event.method
              ? [{ method: event.method, amount: paid, tendered: event.method.kind === "CASH" ? paid : null, change: event.method.kind === "CASH" ? new Decimal(0) : null, reference: null }]
              : [];
          const notes: Parameters<typeof writeSale>[2]["notes"] = [];
          await writeSale(tx, context, {
            requestId: randomUUID(),
            terminal,
            sequence,
            receiptNumber: `${RECEIPT_PREFIX}${event.receipt}`,
            lines: event.lines.map((line) => ({ ...line, location: shelf })),
            locationName,
            discount: event.discount,
            discountPercent: null,
            discountReason: `Given before KuchPos; brought in from Excel (${label}).`,
            total: event.total,
            customer: event.customer,
            credit: event.credit,
            owedAfter,
            creditNote: owedAfter ? `Sold on credit on ${formatDay(event.day)}, before KuchPos; brought in from Excel (${label}).` : null,
            payments,
            tillSessionId: null,
            // The name on the shop's own record; not one of KuchPos's users.
            cashier: { userId: null, name: event.soldBy || SOLD_BY_UNKNOWN },
            deviceTime: null,
            offline: false,
            sentBy: null,
            acceptShortage: true,
            notes,
            imported: { runId: run.id, at: event.at },
            taxRate,
          });
          exceptions += notes.length;
        }

        await tx.activityLog.create({
          data: activityRow(context, {
            action: "import.history",
            summary:
              `${who.name} brought in ${preview.fileName} (${label}): ${count(preview.deliveries, "delivery", "deliveries")} costing ${formatNaira(new Decimal(preview.deliveriesCost))} ` +
              `and ${count(preview.sales, "sale", "sales")} worth ${formatNaira(new Decimal(preview.salesTotal))}` +
              (preview.firstDay && preview.lastDay ? `, from ${formatDay(preview.firstDay)} to ${formatDay(preview.lastDay)}` : "") +
              (exceptions > 0 ? `. ${count(exceptions, "product was", "products were")} sold beyond the stock on record — see the exceptions list.` : "."),
            targetType: "import_run",
            targetId: run.id,
          }),
        });
        return { id: run.id, number, exceptions, preview };
      },
      // A month of a shop's sales is thousands of rows: far more time is allowed than for one sale.
      { isolationLevel: "ReadCommitted", timeout: 300_000, maxWait: 20_000 },
    );

  for (let attempt = 1; ; attempt++) {
    try {
      return await save();
    } catch (error) {
      const known = error instanceof Prisma.PrismaClientKnownRequestError ? error.code : null;
      // Blocked by a sale or delivery saved at the same moment, and undone completely: try again.
      if (known === "P2034" && attempt < MAX_ATTEMPTS) continue;
      if (known === "P2002") {
        throw new ValidationError(
          "Nothing was brought in: a delivery or receipt in the workbook was added to KuchPos while it was being checked (the same file sent twice, perhaps). Upload it again to see where it stands.",
        );
      }
      throw error;
    }
  }
}
