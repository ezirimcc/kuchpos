import "server-only";
import { z } from "zod";
import { adjustmentNumber, countNumber, plainNumber, receiptNumber, returnNumber, shopToday, tillSessionNumber, transferNumber } from "@/lib/format";
import type { AppContext } from "@/server/auth/context";
import { parseInput } from "@/server/auth/users";
import type { Paged } from "@/server/paging";
import { authorize } from "@/server/permissions";
import { listActivity } from "./activity-log";
import { listAdjustments } from "./adjustments";
import { listProducts } from "./catalog";
import { listCustomers } from "./customers";
import type { ReportExport } from "./reports";
import { listReturns } from "./returns";
import { listSales } from "./sales";
import { listReceipts, listStockOnHand } from "./stock";
import { listTillSessions } from "./till";
import { listTransfers } from "./transfers";

/**
 * The list pages as tables for a CSV file (C66): Products, Customers, Sales, Returns, Stock
 * on hand, Deliveries, Transfers, Adjustments, Till sessions and the Activity log.
 *
 * An export is the list the person is looking at — every page of it, with the filters they
 * have applied — and nothing more: it is put together by calling the SAME list operation the
 * screen calls, page after page, so each of those operations' own permission check and
 * business scope decides what goes into the file. On top of that the person must hold the
 * right to export.
 */

const LISTS = ["products", "customers", "sales", "returns", "stock", "deliveries", "transfers", "adjustments", "tills", "activity"] as const;
export type ExportableList = (typeof LISTS)[number];

/** The most rows one file holds. A list longer than this is cut off there (narrow it with the page's filters). */
const MAX_ROWS = 20_000;
const SHOP_OFFSET_MS = 60 * 60 * 1000;

const schema = z.object({ list: z.enum(LISTS) }).passthrough();

/** Calls a list operation page after page and gathers the rows. */
async function everyPage<Row>(fetch: (page: number) => Promise<{ rows: Row[] } & Paged>): Promise<Row[]> {
  const all: Row[] = [];
  for (let page = 1; ; page += 1) {
    const result = await fetch(page);
    all.push(...result.rows);
    if (page >= result.pageCount || result.rows.length === 0 || all.length >= MAX_ROWS) break;
  }
  return all.slice(0, MAX_ROWS);
}

/** A moment as "2026-10-01 14:35" by the shop's clock: plain text a spreadsheet sorts correctly. */
const when = (moment: Date | null | undefined) => (moment ? new Date(moment.getTime() + SHOP_OFFSET_MS).toISOString().slice(0, 16).replace("T", " ") : "");
const yesNo = (value: boolean) => (value ? "Yes" : "No");

export async function exportList(context: AppContext, input: unknown): Promise<ReportExport> {
  authorize(context, "report.export");
  const { list, ...asked } = parseInput(schema, input);
  // What came in the address is text; the list operations check it themselves.
  const filters = Object.fromEntries(Object.entries(asked).filter(([key, value]) => key !== "page" && typeof value === "string")) as Record<string, string>;
  const filename = `${list}_${shopToday()}.csv`;

  switch (list) {
    case "products": {
      const products = await everyPage(async (page) => {
        const result = await listProducts(context, { ...filters, includeInactive: filters.includeInactive === "1", page });
        return { ...result, rows: result.products };
      });
      return {
        filename,
        header: ["Product", "Code", "Barcode", "Category", "Unit", "Contains (smallest units)", "Selling price", "Sold in this unit", "Bought in this unit", "Sold in fractions", "Taxable", "In use"],
        // One row per unit, like the import template.
        rows: products.flatMap((product) =>
          product.units.map((unit) => [
            product.name,
            product.code,
            product.barcode,
            product.category?.name ?? "",
            unit.name,
            plainNumber(unit.factor),
            unit.price,
            yesNo(unit.forSale),
            yesNo(unit.forPurchase),
            yesNo(product.allowsFraction),
            yesNo(product.taxable),
            yesNo(product.active),
          ]),
        ),
      };
    }
    case "customers": {
      let showsPurchases = false;
      const customers = await everyPage(async (page) => {
        const result = await listCustomers(context, { ...filters, page });
        showsPurchases = result.showsPurchases;
        return { ...result, rows: result.customers };
      });
      return {
        filename,
        header: ["Customer", "Phone", "City", "State", "Credit limit", "Owes now", ...(showsPurchases ? ["Total purchases", "Visits"] : []), "In use"],
        rows: customers.map((customer) => [
          customer.name,
          customer.phone,
          customer.city,
          customer.state,
          customer.creditLimit,
          customer.balance,
          ...(showsPurchases ? [customer.purchases, customer.visits] : []),
          yesNo(customer.active),
        ]),
      };
    }
    case "sales": {
      const sales = await everyPage(async (page) => {
        const result = await listSales(context, { ...filters, page });
        return { ...result, rows: result.sales };
      });
      return {
        filename,
        header: ["Receipt", "When", "Customer", "Served by", "Lines", "Products", "Total", "On credit", "Cancelled"],
        rows: sales.map((sale) => [
          sale.receiptNumber,
          when(sale.createdAt),
          sale.customerName ?? "Walk-in",
          sale.cashierName,
          sale.lineCount,
          sale.products.join("; "),
          sale.total,
          sale.creditAmount,
          yesNo(sale.cancelled),
        ]),
      };
    }
    case "returns": {
      const returns = await everyPage(async (page) => {
        const result = await listReturns(context, { ...filters, page });
        return { ...result, rows: result.returns };
      });
      return {
        filename,
        header: ["Return", "When", "For receipt", "Customer", "Reason", "Taken back by", "Approved by", "Refund", "Some written off"],
        rows: returns.map((row) => [
          returnNumber(row.number),
          when(row.createdAt),
          row.saleReceiptNumber,
          row.customerName ?? "Walk-in",
          row.reason,
          row.createdByName,
          row.approvedByName,
          row.refundTotal,
          yesNo(row.hasWriteOff),
        ]),
      };
    }
    case "stock": {
      let locations: { id: string; name: string }[] = [];
      const stock = await everyPage(async (page) => {
        const result = await listStockOnHand(context, { ...filters, page });
        locations = result.locations;
        return result;
      });
      return {
        filename: `stock-on-hand_${shopToday()}.csv`,
        header: ["Product", "Code", "Category", "Unit", ...locations.map((location) => location.name), "In all"],
        rows: stock.map((row) => [
          row.productName,
          row.code,
          row.category,
          row.baseUnitName,
          ...locations.map((location) => plainNumber(row.byLocation[location.id] ?? "0.000")),
          plainNumber(row.total),
        ]),
      };
    }
    case "deliveries": {
      const deliveries = await everyPage(async (page) => {
        const result = await listReceipts(context, { ...filters, page });
        return { ...result, rows: result.receipts };
      });
      return {
        filename,
        header: ["Delivery", "Delivery date", "Supplier", "Received into", "Lines", "Total cost", "Backdated", "Times corrected", "Entered by", "Entered at"],
        rows: deliveries.map((row) => [
          receiptNumber(row.number),
          row.receivedOn,
          row.supplierName,
          row.locationName,
          row.lineCount,
          row.totalCost,
          yesNo(row.backdated),
          row.version - 1,
          row.createdByName,
          when(row.createdAt),
        ]),
      };
    }
    case "transfers": {
      const transfers = await everyPage(async (page) => {
        const result = await listTransfers(context, { ...filters, page });
        return { ...result, rows: result.transfers };
      });
      return {
        filename,
        header: ["Transfer", "When", "From", "To", "Lines", "Products", "By"],
        rows: transfers.map((row) => [transferNumber(row.number), when(row.createdAt), row.fromLocationName, row.toLocationName, row.lineCount, row.products.join("; "), row.createdByName]),
      };
    }
    case "adjustments": {
      const adjustments = await everyPage(async (page) => {
        const result = await listAdjustments(context, { ...filters, page });
        return { ...result, rows: result.adjustments };
      });
      return {
        filename,
        header: ["Adjustment", "When", "Place", "Status", "Lines", "Products", "From count", "Entered by", "Decided by", "Decided at"],
        rows: adjustments.map((row) => [
          adjustmentNumber(row.number),
          when(row.createdAt),
          row.locationName,
          row.status,
          row.lineCount,
          row.products.join("; "),
          row.countNumber ? countNumber(row.countNumber) : "",
          row.createdByName,
          row.decidedByName,
          when(row.decidedAt),
        ]),
      };
    }
    case "tills": {
      const sessions = await everyPage(async (page) => {
        const result = await listTillSessions(context, { ...filters, page });
        return { ...result, rows: result.sessions };
      });
      return {
        filename: `till-sessions_${shopToday()}.csv`,
        header: ["Session", "Checkout", "Opened by", "Opened at", "Closed by", "Closed at", "Over or short"],
        rows: sessions.map((row) => [tillSessionNumber(row.number), row.terminalCode, row.openedByName, when(row.openedAt), row.closedByName, when(row.closedAt), row.difference]),
      };
    }
    case "activity": {
      const entries = await everyPage(async (page) => {
        const result = await listActivity(context, { ...filters, page });
        return { ...result, rows: result.entries };
      });
      return {
        filename: `activity-log_${shopToday()}.csv`,
        header: ["When", "Who", "Role", "What happened"],
        rows: entries.map((entry) => [when(entry.createdAt), entry.actorName, entry.actorRole, entry.summary]),
      };
    }
  }
}
