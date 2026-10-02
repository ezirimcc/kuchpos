import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { Alert } from "@/components/ui/alert";
import { requireContext } from "@/server/auth/request";
import { NotSignedInError } from "@/server/errors";
import { SignInForm } from "./sign-in-form";

export const metadata: Metadata = { title: "Sign in — KuchPos" };

export default async function SignInPage({ searchParams }: PageProps<"/sign-in">) {
  const { reason } = await searchParams;
  let alreadySignedIn = false;
  try {
    await requireContext();
    alreadySignedIn = true;
  } catch (error) {
    if (!(error instanceof NotSignedInError)) throw error;
  }
  if (alreadySignedIn) redirect("/");

  return (
    <main className="flex flex-1 flex-col items-center justify-center gap-6 p-6">
      <div className="text-center">
        <h1 className="text-3xl font-semibold tracking-tight">KuchPos</h1>
        <p className="mt-1 text-sm text-muted-foreground">Sign in with the username your admin gave you.</p>
      </div>
      {reason === "idle" && (
        <Alert className="w-full max-w-sm">
          You were signed out because the screen was not used for a while. Sign in again to continue.
        </Alert>
      )}
      <SignInForm />
    </main>
  );
}
