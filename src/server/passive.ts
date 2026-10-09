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
  return answer(work, { passive: true });
}

/**
 * For work the checkout computer sends by itself when the internet returns (sales made
 * offline). Unlike a passive read this changes data, so it must come from this site's own
 * pages: a request from anywhere else is refused before anything is looked at.
 */
export async function answerFromOwnPages(request: Request, work: (context: AppContext) => Promise<unknown>): Promise<Response> {
  const origin = request.headers.get("origin");
  const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host");
  let sameSite = false;
  try {
    sameSite = !!origin && !!host && new URL(origin).host === host;
  } catch {
    sameSite = false;
  }
  if (!sameSite || request.headers.get("sec-fetch-site") === "cross-site") {
    return Response.json({ error: "not-allowed" }, { status: 403, headers: { "cache-control": "no-store" } });
  }
  return answer(work, { passive: false });
}

async function answer(work: (context: AppContext) => Promise<unknown>, options: { passive: boolean }): Promise<Response> {
  const fresh = { "cache-control": "no-store" };
  try {
    const context = await resolveContext(await headers(), options);
    return Response.json(await work(context), { headers: fresh });
  } catch (error) {
    if (error instanceof NotSignedInError) return Response.json({ error: "signed-out" }, { status: 401, headers: fresh });
    if (error instanceof ForbiddenError) return Response.json({ error: "not-allowed" }, { status: 403, headers: fresh });
    if (error instanceof NotFoundError) return Response.json({ error: "not-found" }, { status: 404, headers: fresh });
    // Refused as it stands: the caller is told why, in words for the screen.
    if (error instanceof ValidationError) {
      return Response.json({ error: "refused", message: error.message, fieldErrors: error.fieldErrors }, { status: 422, headers: fresh });
    }
    console.error("Request failed:", error);
    return Response.json({ error: "failed" }, { status: 500, headers: fresh });
  }
}
