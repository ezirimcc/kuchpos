import { getOfflineKit } from "@/server/business/offline";
import { answerPassively } from "@/server/passive";

/** What the checkout computer keeps so it can sell without internet. Asked for by the screen itself. */
export async function GET(): Promise<Response> {
  return answerPassively((context) => getOfflineKit(context));
}
