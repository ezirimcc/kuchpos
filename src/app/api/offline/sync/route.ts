import { z } from "zod";
import { parseInput } from "@/server/auth/users";
import { postOfflineSale } from "@/server/business/sales";
import { openTillOffline } from "@/server/business/till";
import { answerFromOwnPages } from "@/server/passive";

const bodySchema = z.object({ kind: z.enum(["sale", "till"]), payload: z.unknown() });

/**
 * One piece of work done on the checkout computer during an outage — a sale, or the opening
 * of a till — sent when the internet is back. Sending the same piece again changes nothing.
 */
export async function POST(request: Request): Promise<Response> {
  return answerFromOwnPages(request, async (context) => {
    const { kind, payload } = parseInput(bodySchema, await request.json().catch(() => null));
    if (kind === "till") return { kind, ...(await openTillOffline(context, payload)) };
    const saved = await postOfflineSale(context, payload);
    return { kind, receiptNumber: saved.receiptNumber, alreadySaved: saved.alreadySaved };
  });
}
