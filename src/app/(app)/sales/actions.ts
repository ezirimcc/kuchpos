"use server";

import type { FormState } from "@/lib/form-state";
import { runAction } from "@/server/action";
import { postSale, recordReceiptPrint, type SaleResult } from "@/server/business/sales";

/** Saves a sale sent whole from the checkout screen. On success the answer carries the saved sale. */
export async function postSaleAction(input: unknown): Promise<FormState & { sale?: SaleResult }> {
  let sale: SaleResult | undefined;
  const result = await runAction({ success: "Sale saved." }, async (context) => {
    sale = await postSale(context, input);
  });
  return result.status === "success" ? { ...result, sale } : result;
}

/** Notes that a receipt is about to be printed, and says whether this is a reprint. */
export async function recordReceiptPrintAction(saleId: string): Promise<FormState & { reprint?: boolean }> {
  let reprint: boolean | undefined;
  const result = await runAction({ success: "Printing." }, async (context) => {
    reprint = (await recordReceiptPrint(context, { saleId })).reprint;
  });
  return result.status === "success" ? { ...result, reprint } : result;
}
