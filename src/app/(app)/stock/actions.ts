"use server";

import type { FormState } from "@/lib/form-state";
import { field, runAction } from "@/server/action";
import { adjustFromCount, decideAdjustment, recordAdjustment } from "@/server/business/adjustments";
import { submitCount } from "@/server/business/counts";
import { correctReceipt } from "@/server/business/receipt-corrections";
import { receiveGoods } from "@/server/business/stock";
import { createSupplier, setSupplierActive, updateSupplier } from "@/server/business/suppliers";
import { transferStock } from "@/server/business/transfers";

/** Saves a delivery. On success the answer carries the new delivery's id so the screen can open it. */
export async function receiveGoodsAction(input: unknown): Promise<FormState & { receiptId?: string }> {
  let receiptId: string | undefined;
  const result = await runAction({ success: "Delivery saved." }, async (context) => {
    receiptId = (await receiveGoods(context, input)).id;
  });
  return result.status === "success" ? { ...result, receiptId } : result;
}

/** Saves a correction of a saved delivery. On success the answer carries the delivery's id. */
export async function correctReceiptAction(input: unknown): Promise<FormState & { receiptId?: string }> {
  let receiptId: string | undefined;
  const result = await runAction({ success: "Correction saved." }, async (context) => {
    receiptId = (await correctReceipt(context, input)).id;
  });
  return result.status === "success" ? { ...result, receiptId } : result;
}

/** Saves a transfer between locations. On success the answer carries the new transfer's id. */
export async function transferStockAction(input: unknown): Promise<FormState & { transferId?: string }> {
  let transferId: string | undefined;
  const result = await runAction({ success: "Stock moved." }, async (context) => {
    transferId = (await transferStock(context, input)).id;
  });
  return result.status === "success" ? { ...result, transferId } : result;
}

/** Saves a stock count. On success the answer carries the count's id so the screen can show the differences. */
export async function submitCountAction(input: unknown): Promise<FormState & { countId?: string }> {
  let countId: string | undefined;
  const result = await runAction({ success: "Count saved." }, async (context) => {
    countId = (await submitCount(context, input)).id;
  });
  return result.status === "success" ? { ...result, countId } : result;
}

/** Records an adjustment entered directly. It is applied at once or waits for approval, depending on who entered it. */
export async function recordAdjustmentAction(input: unknown): Promise<FormState & { adjustmentId?: string }> {
  let adjustmentId: string | undefined;
  const result = await runAction({ success: "Adjustment saved." }, async (context) => {
    adjustmentId = (await recordAdjustment(context, input)).id;
  });
  return result.status === "success" ? { ...result, adjustmentId } : result;
}

/** Records the adjustment for the differences a stock count found. */
export async function adjustFromCountAction(input: unknown): Promise<FormState & { adjustmentId?: string }> {
  let adjustmentId: string | undefined;
  const result = await runAction({ success: "Adjustment saved." }, async (context) => {
    adjustmentId = (await adjustFromCount(context, input)).id;
  });
  return result.status === "success" ? { ...result, adjustmentId } : result;
}

/** Approves (and applies) or rejects an adjustment that is waiting. */
export async function decideAdjustmentAction(input: unknown): Promise<FormState> {
  return runAction({ success: "Decision saved." }, (context) => decideAdjustment(context, input));
}

/** Adds a supplier from inside the delivery form and reports its id. */
export async function quickCreateSupplierAction(name: string): Promise<FormState & { supplierId?: string }> {
  let supplierId: string | undefined;
  const result = await runAction({ success: "Supplier added." }, async (context) => {
    supplierId = (await createSupplier(context, { name, phone: "", note: "" })).id;
  });
  return result.status === "success" ? { ...result, supplierId } : result;
}

export async function createSupplierAction(_previous: FormState, formData: FormData): Promise<FormState> {
  return runAction({ success: "Supplier added." }, (context) =>
    createSupplier(context, {
      name: field(formData, "name"),
      phone: field(formData, "phone"),
      note: field(formData, "note"),
    }),
  );
}

export async function updateSupplierAction(_previous: FormState, formData: FormData): Promise<FormState> {
  return runAction({ success: "Supplier saved." }, (context) =>
    updateSupplier(context, {
      supplierId: field(formData, "supplierId"),
      name: field(formData, "name"),
      phone: field(formData, "phone"),
      note: field(formData, "note"),
    }),
  );
}

export async function setSupplierActiveAction(_previous: FormState, formData: FormData): Promise<FormState> {
  const active = field(formData, "active") === "true";
  return runAction({ success: active ? "Supplier brought back." : "Supplier taken out of use." }, (context) =>
    setSupplierActive(context, { supplierId: field(formData, "supplierId"), active }),
  );
}
