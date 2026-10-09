"use server";

import type { FormState } from "@/lib/form-state";
import { runAction } from "@/server/action";
import { type ApprovalGiven, approveAtScreen, decideApprovalRequest, requestApproval, withdrawApprovalRequest } from "@/server/business/approvals";
import { reviewOfflineException } from "@/server/business/offline";
import { cancelSale, postSale, recordReceiptPrint, type SaleResult } from "@/server/business/sales";

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

/** Cancels a whole sale: goods back to stock, payments refunded, the sale marked as cancelled. */
export async function cancelSaleAction(input: unknown): Promise<FormState> {
  return runAction({ success: "Sale cancelled." }, (context) => cancelSale(context, input));
}

/**
 * A manager approves a discount, or credit over a customer's limit, at the cashier's screen.
 * On success the answer carries the approval to send with the sale.
 */
export async function approveAtScreenAction(input: unknown): Promise<FormState & { approval?: { id: string; approvedByName: string } }> {
  let given: ApprovalGiven | undefined;
  const result = await runAction({ success: "Approved." }, async (context) => {
    given = await approveAtScreen(context, input);
  });
  return result.status === "success" && given ? { ...result, approval: { id: given.approvalId, approvedByName: given.approvedByName } } : result;
}

/** Sends a discount, or credit over a limit, to be approved from a manager's own computer. */
export async function requestApprovalAction(input: unknown): Promise<FormState & { requestId?: string }> {
  let requestId: string | undefined;
  const result = await runAction({ success: "Sent for approval." }, async (context) => {
    requestId = (await requestApproval(context, input)).requestId;
  });
  return result.status === "success" ? { ...result, requestId } : result;
}

/** The cashier takes a request back. */
export async function withdrawApprovalRequestAction(requestId: string): Promise<FormState> {
  return runAction({ success: "Request taken back." }, (context) => withdrawApprovalRequest(context, { requestId }));
}

/** A manager approves or refuses a waiting request from their own computer. */
export async function decideApprovalRequestAction(input: { requestId: string; approve: boolean; note: string }): Promise<FormState> {
  return runAction({ success: input.approve ? "Approved." : "Refused." }, (context) => decideApprovalRequest(context, input));
}

/** A manager marks an offline exception as looked at. */
export async function reviewOfflineExceptionAction(input: { exceptionId: string; note: string }): Promise<FormState> {
  return runAction({ success: "Marked as looked at." }, (context) => reviewOfflineException(context, input));
}
