import { listWaitingApprovals } from "@/server/business/approvals";
import { listWaitingTillCash } from "@/server/business/till";
import { answerPassively } from "@/server/passive";
import { can } from "@/server/permissions";

/**
 * Everything waiting for this person's answer: discounts and credit sent from a checkout,
 * and cash in / cash out asked for at a till. Asked for by the screen itself.
 */
export async function GET(): Promise<Response> {
  return answerPassively(async (context) => {
    const sales = can(context, "discount.approve") || can(context, "customer.setCreditLimit");
    const tills = can(context, "till.reviewAny") && can(context, "till.operateOwn");
    const [approvals, cash] = await Promise.all([
      // With neither right this is what refuses the request.
      sales || !tills ? listWaitingApprovals(context) : { requests: [] },
      tills ? listWaitingTillCash(context) : { requests: [] },
    ]);
    return { requests: approvals.requests, cashRequests: cash.requests };
  });
}
