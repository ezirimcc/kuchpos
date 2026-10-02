import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

/**
 * Sends anyone who arrives over plain HTTP to the HTTPS address, so a password
 * is never typed into an unprotected page. The hosting server tells the app how
 * the visitor connected through the "x-forwarded-proto" header; when that header
 * is absent (for example on a development computer) nothing happens.
 */
export function proxy(request: NextRequest) {
  if (request.headers.get("x-forwarded-proto") !== "http") {
    return NextResponse.next();
  }
  const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host");
  if (!host || host.startsWith("localhost") || host.startsWith("127.0.0.1")) {
    return NextResponse.next();
  }
  const target = new URL(request.nextUrl.pathname + request.nextUrl.search, `https://${host}`);
  return NextResponse.redirect(target, 308);
}

export const config = {
  // Everything except the app's own static files.
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
