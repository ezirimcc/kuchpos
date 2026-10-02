import "server-only";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { cache } from "react";
import { NotSignedInError } from "@/server/errors";
import { can, type Permission } from "@/server/permissions";
import { type AppContext, resolveContext } from "./context";

/** The signed-in person for the current request. Looked up once per request. Throws if signed out. */
export const requireContext = cache(async (): Promise<AppContext> => {
  return resolveContext(await headers());
});

/** For pages: sends signed-out visitors to the sign-in page. */
export async function requirePageContext(): Promise<AppContext> {
  try {
    return await requireContext();
  } catch (error) {
    if (error instanceof NotSignedInError) {
      redirect(error.reason === "idle" ? "/sign-in?reason=idle" : "/sign-in");
    }
    throw error;
  }
}

/** For pages: also sends people without the permission back to the home page. */
export async function requirePagePermission(permission: Permission): Promise<AppContext> {
  const context = await requirePageContext();
  if (!can(context, permission)) redirect("/");
  return context;
}
