import type { Metadata } from "next";
import { ActionForm, SubmitButton, TextField } from "@/components/action-form";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { requirePageContext } from "@/server/auth/request";
import { ROLE_LABELS } from "@/server/permissions";
import { changeOwnPasswordAction } from "./actions";

export const metadata: Metadata = { title: "My account — KuchPos" };

export default async function AccountPage() {
  const context = await requirePageContext();

  return (
    <div className="flex max-w-xl flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">My account</h1>
        <p className="text-sm text-muted-foreground">
          {context.actor.name} · username <span className="font-medium">{context.actor.username}</span> ·{" "}
          {ROLE_LABELS[context.actor.role]}
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Change my password</CardTitle>
          <CardDescription>
            Choose a password only you know. If you are signed in on another computer, that one will be signed out.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ActionForm action={changeOwnPasswordAction} resetOnSuccess className="flex flex-col gap-1">
            <TextField name="currentPassword" label="Current password" type="password" autoComplete="current-password" required />
            <TextField
              name="newPassword"
              label="New password"
              type="password"
              hint="At least 8 characters"
              autoComplete="new-password"
              required
            />
            <TextField name="repeatPassword" label="New password again" type="password" autoComplete="new-password" required />
            <div>
              <SubmitButton className="mt-2">Change password</SubmitButton>
            </div>
          </ActionForm>
        </CardContent>
      </Card>
    </div>
  );
}
