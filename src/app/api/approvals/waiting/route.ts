import { listWaitingApprovals } from "@/server/business/approvals";
import { answerPassively } from "@/server/passive";

/** The approval requests waiting for this person's answer. Asked for by the screen itself. */
export async function GET(): Promise<Response> {
  return answerPassively((context) => listWaitingApprovals(context));
}
