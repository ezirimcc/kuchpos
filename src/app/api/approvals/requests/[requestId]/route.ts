import { getApprovalRequest } from "@/server/business/approvals";
import { answerPassively } from "@/server/passive";

/** What has become of an approval request, for the cashier's screen that sent it. */
export async function GET(_request: Request, { params }: RouteContext<"/api/approvals/requests/[requestId]">): Promise<Response> {
  const { requestId } = await params;
  return answerPassively((context) => getApprovalRequest(context, { requestId }));
}
