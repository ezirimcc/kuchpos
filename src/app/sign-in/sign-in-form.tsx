"use client";

import { useRouter } from "next/navigation";
import { useState, useSyncExternalStore } from "react";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { authClient } from "@/lib/auth-client";

const never = () => () => {};

export function SignInForm() {
  const router = useRouter();
  // False in the page as the server sends it, true once the browser has taken over. Until
  // then the button is off: a form sent before that would be sent by the browser itself,
  // which would put the password in the address bar.
  const ready = useSyncExternalStore(never, () => true, () => false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    const form = new FormData(event.currentTarget);
    setPending(true);
    setError(null);

    const result = await authClient.signIn.username({
      username: String(form.get("username") ?? "").trim().toLowerCase(),
      password: String(form.get("password") ?? ""),
    });

    if (result.error) {
      // A disabled account or deactivated business gets its own message; anything else stays vague on purpose.
      setError(
        result.error.status === 403 && result.error.message
          ? result.error.message
          : "The username or password is not correct.",
      );
      setPending(false);
      return;
    }
    router.replace("/");
    router.refresh();
  }

  return (
    <Card className="w-full max-w-sm">
      <CardContent>
        {/* method="post" so that, whatever happens, the browser never puts the password in an address. */}
        <form onSubmit={onSubmit} method="post" className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="username">Username</Label>
            <Input id="username" name="username" autoComplete="username" autoCapitalize="none" autoFocus required />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="password">Password</Label>
            <Input id="password" name="password" type="password" autoComplete="current-password" required />
          </div>
          {error && <Alert variant="destructive">{error}</Alert>}
          <Button type="submit" size="lg" disabled={pending || !ready} className="mt-1">
            {pending ? "Signing in…" : "Sign in"}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
