import { Sprout } from "lucide-react";
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
      <div className="flex flex-col items-center gap-3 text-center">
        <span className="bg-brand-gradient flex size-14 items-center justify-center rounded-2xl text-white shadow-sm">
          <Sprout className="size-8" aria-hidden />
        </span>
        <div>
          <h1 className="text-3xl font-semibold tracking-tight">KuchPos</h1>
          <p className="mt-1 text-sm text-muted-foreground">Sign in with the username your admin gave you.</p>
        </div>
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
