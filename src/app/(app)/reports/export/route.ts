import { headers } from "next/headers";
import { toCsv } from "@/lib/csv";
import { resolveContext } from "@/server/auth/context";
import { exportReport } from "@/server/business/reports";
import { ForbiddenError, NotSignedInError, ValidationError } from "@/server/errors";

/**
 * Downloads one report as a CSV file. The person is identified and their rights checked
 * exactly as for the screen; the file holds what that screen would show them, no more.
 */
export async function GET(request: Request): Promise<Response> {
  try {
    const context = await resolveContext(await headers());
    const params = Object.fromEntries(new URL(request.url).searchParams.entries());
    const report = await exportReport(context, params);
    return new Response(toCsv(report.header, report.rows), {
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="${report.filename}"`,
        "cache-control": "no-store",
      },
    });
  } catch (error) {
    if (error instanceof NotSignedInError) return Response.redirect(new URL("/sign-in", request.url), 303);
    if (error instanceof ForbiddenError) return new Response("You are not allowed to export this report.", { status: 403 });
    if (error instanceof ValidationError) return new Response(error.message, { status: 422 });
    console.error("Export failed:", error);
    return new Response("The report could not be exported. Please try again.", { status: 500 });
  }
}
