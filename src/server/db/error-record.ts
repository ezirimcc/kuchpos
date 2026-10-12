import "server-only";
import { getDb } from "@/server/db/client";

/**
 * Notes something that went wrong unexpectedly in the app's own error log (C68), for the
 * owners to read on the Error log page. It is also written to the server's console, as before.
 *
 * It must never make things worse: it never throws, and it waits for nothing the person is
 * waiting for. It stores the error's own message and trace, where it happened and who was
 * signed in — never request headers, cookies, passwords or what was typed into a form.
 */
export async function recordError(input: {
  kind: "action" | "request" | "page" | "route";
  place: string;
  error: unknown;
  digest?: string | null;
  context?: { actor: { userId: string; name: string }; business: { id: string } | null } | null;
}): Promise<void> {
  try {
    const error = input.error;
    const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    const detail = error instanceof Error ? (error.stack ?? null) : null;
    await getDb().errorLog.create({
      data: {
        kind: input.kind,
        place: input.place.slice(0, 300),
        message: message.replace(/\s+/g, " ").trim().slice(0, 1000) || "Unknown error",
        detail: detail ? detail.slice(0, 8000) : null,
        digest: input.digest ? input.digest.slice(0, 100) : null,
        businessId: input.context?.business?.id ?? null,
        userId: input.context?.actor.userId ?? null,
        userName: input.context?.actor.name ?? null,
        appVersion: (process.env.KUCHPOS_VERSION ?? "development").slice(0, 60),
      },
    });
  } catch (failure) {
    // The database itself may be what is wrong. The console still has the original error.
    console.error("The error log could not be written:", failure);
  }
}
