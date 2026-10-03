import { UserRound } from "lucide-react";
import type { Metadata } from "next";
import { ActionForm, SubmitButton, TextField } from "@/components/action-form";
import { PageHeader } from "@/components/page-header";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { formatDate, formatDateTime } from "@/lib/format";
import { getOwnProfile } from "@/server/auth/account";
import { requirePageContext } from "@/server/auth/request";
import { ROLE_LABELS } from "@/server/permissions";
import { changeOwnPasswordAction } from "./actions";

export const metadata: Metadata = { title: "My profile — KuchPos" };

function initials(name: string): string {
  const parts = name.trim().split(/\s+/);
  return ((parts[0]?.[0] ?? "") + (parts.length > 1 ? (parts.at(-1)?.[0] ?? "") : "")).toUpperCase();
}

export default async function AccountPage() {
  const context = await requirePageContext();
  const profile = await getOwnProfile(context);

  const facts: [string, string][] = [
    ["Full name", profile.name],
    ["Username", profile.username],
    ["Role", ROLE_LABELS[profile.role]],
    ["Business", profile.businessName ?? "All businesses (owner)"],
    ["Account created", formatDate(profile.accountCreatedAt)],
    ["Signed in on this computer", profile.signedInAt ? formatDateTime(profile.signedInAt) : "—"],
    ["Automatic sign-out", `After ${profile.idleSignOutMinutes} minutes without use`],
  ];

  return (
    <div className="flex max-w-4xl flex-col gap-5">
      <PageHeader icon={UserRound} title="My profile" description="Your account on KuchPos." />

      <Card>
        <CardContent className="flex flex-wrap items-center gap-5">
          <span className="bg-brand-gradient flex size-20 shrink-0 items-center justify-center rounded-3xl text-2xl font-semibold text-white">
            {initials(profile.name)}
          </span>
          <div>
            <p className="text-xl font-semibold" data-testid="profile-name">
              {profile.name}
            </p>
            <p className="text-sm text-muted-foreground">
              {ROLE_LABELS[profile.role]}
              {profile.businessName ? ` · ${profile.businessName}` : ""}
            </p>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Account details</CardTitle>
          <CardDescription>
            To change your name, username or role, ask {profile.role === "OWNER" ? "another owner" : "your admin"}.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <dl className="grid gap-x-8 gap-y-4 sm:grid-cols-2">
            {facts.map(([label, value]) => (
              <div key={label}>
                <dt className="text-xs text-muted-foreground">{label}</dt>
                <dd className="mt-0.5 font-medium" data-testid={`profile-${label.toLowerCase().replace(/\s+/g, "-")}`}>
                  {value}
                </dd>
              </div>
            ))}
          </dl>
        </CardContent>
      </Card>

      <Card id="password" className="scroll-mt-4">
        <CardHeader>
          <CardTitle>Change my password</CardTitle>
          <CardDescription>
            Choose a password only you know. If you are signed in on another computer, that one will be signed out.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ActionForm action={changeOwnPasswordAction} resetOnSuccess className="flex max-w-md flex-col gap-1">
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
