import { isDatabaseReachable } from "@/server/db/client";

/** A simple "is it up?" address for checking a deployment. Reveals nothing sensitive. */
export async function GET(): Promise<Response> {
  const database = await isDatabaseReachable();
  return Response.json(
    { app: "ok", database: database ? "connected" : "not connected" },
    { status: database ? 200 : 503 },
  );
}
