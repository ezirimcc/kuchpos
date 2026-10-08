import "server-only";
import { headers } from "next/headers";
import { type AppContext, resolveContext } from "./auth/context";
import { ForbiddenError, NotFoundError, NotSignedInError, ValidationError } from "./errors";

/**
 * For the few addresses a screen asks by itself, every few seconds, to see whether there is
 * news (an approval waiting, an answer to a request). The person is identified and checked
 * exactly as everywhere else, but the request does not count as "using the screen", so it
 * cannot keep someone signed in. Read-only work only.
 */
export async function answerPassively(work: (context: AppContext) => Promise<unknown>): Promise<Response> {
  const fresh = { "cache-control": "no-store" };
  try {
    const context = await resolveContext(await headers(), { passive: true });
    return Response.json(await work(context), { headers: fresh });
  } catch (error) {
    if (error instanceof NotSignedInError) return Response.json({ error: "signed-out" }, { status: 401, headers: fresh });
    if (error instanceof ForbiddenError) return Response.json({ error: "not-allowed" }, { status: 403, headers: fresh });
    if (error instanceof NotFoundError || error instanceof ValidationError) return Response.json({ error: "not-found" }, { status: 404, headers: fresh });
    console.error("Passive request failed:", error);
    return Response.json({ error: "failed" }, { status: 500, headers: fresh });
  }
}
