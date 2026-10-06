"use server";

import type { FormState } from "@/lib/form-state";
import { field, runAction } from "@/server/action";
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
