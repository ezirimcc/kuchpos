import "server-only";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { type AppContext, resolveContext } from "./auth/context";
import { AppError, NotSignedInError, ValidationError } from "./errors";
import type { FormState } from "@/lib/form-state";

/**
 * Every server action goes through here. It identifies the signed-in person
 * first, runs the operation (which checks permissions itself), and turns any
 * problem into a plain message for the screen. Technical details go to the log.
 */
export async function runAction(
  options: { success: string },
  work: (context: AppContext) => Promise<unknown>,
): Promise<FormState> {
  let signedOut: NotSignedInError | null = null;
  try {
    // Looked up fresh, not through the per-request cache that pages use: the page is
    // re-drawn in this same request after the action, and must see what the action changed
    // (for example, which business an owner has just opened).
    const context = await resolveContext(await headers());
    await work(context);
  } catch (error) {
    if (error instanceof NotSignedInError) {
      signedOut = error;
    } else if (error instanceof ValidationError) {
      return { status: "error", message: error.message, fieldErrors: error.fieldErrors };
    } else if (error instanceof AppError) {
      return { status: "error", message: error.message, fieldErrors: {} };
    } else {
      console.error("Action failed:", error);
      return {
        status: "error",
        message: "Something went wrong and nothing was saved. Please try again.",
        fieldErrors: {},
      };
    }
  }
  if (signedOut) redirect(signedOut.reason === "idle" ? "/sign-in?reason=idle" : "/sign-in");

  // Re-draw everything, including the header and menu that screens share. Without this the
  // browser keeps the old header after, say, an owner opens a different business.
  revalidatePath("/", "layout");
  return { status: "success", message: options.success };
}

/** Reads a text field from a submitted form. Missing fields become an empty string. */
export function field(formData: FormData, name: string): string {
  const value = formData.get(name);
  return typeof value === "string" ? value : "";
}
