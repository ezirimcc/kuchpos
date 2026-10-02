import { toNextJsHandler } from "better-auth/next-js";
import { ALLOWED_AUTH_PATHS, getAuth } from "@/server/auth/auth";

function isAllowed(request: Request): boolean {
  const { pathname } = new URL(request.url);
  return ALLOWED_AUTH_PATHS.some((entry) => entry.method === request.method && entry.path === pathname);
}

function notFound(): Response {
  return new Response("Not found", { status: 404 });
}

export async function GET(request: Request): Promise<Response> {
  if (!isAllowed(request)) return notFound();
  return toNextJsHandler(getAuth()).GET(request);
}

export async function POST(request: Request): Promise<Response> {
  if (!isAllowed(request)) return notFound();
  return toNextJsHandler(getAuth()).POST(request);
}
