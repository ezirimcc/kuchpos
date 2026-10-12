import type { Instrumentation } from "next";

/**
 * Called by Next.js whenever the server fails while drawing a screen or answering a request
 * and nothing in our own code caught it. The failure goes into the app's own error log
 * (C68). Failures inside forms and buttons are caught earlier, by `runAction`, and are
 * logged from there.
 */
export const onRequestError: Instrumentation.onRequestError = async (error, request, context) => {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { recordError } = await import("@/server/error-log");
  const digest = typeof error === "object" && error !== null && "digest" in error ? String(error.digest) : null;
  await recordError({
    kind: context.routeType === "render" ? "page" : context.routeType === "action" ? "action" : "route",
    // The address without anything after "?": a search box's contents do not belong in a log.
    place: `${request.method} ${request.path.split("?")[0]}`,
    error,
    digest,
  });
};
