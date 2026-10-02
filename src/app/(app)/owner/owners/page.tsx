import type { Metadata } from "next";
import { ActionForm, SubmitButton, TextField } from "@/components/action-form";
import { ActivityTable } from "@/components/activity-table";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { requirePagePermission } from "@/server/auth/request";
import { listOwners, listPlatformActivity } from "@/server/platform/owners";
import { createOwnerAction, resetOwnerPasswordAction, setOwnerDisabledAction } from "./actions";

export const metadata: Metadata = { title: "Owners — KuchPos" };

export default async function OwnersPage() {
  const context = await requirePagePermission("owner.manage");
  const [owners, activity] = await Promise.all([listOwners(context), listPlatformActivity(context, 50)]);

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Owners</h1>
        <p className="text-sm text-muted-foreground">
          Owners can open every business with full admin rights. Give this role only to people you trust completely.
        </p>
      </div>

      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Name</TableHead>
            <TableHead>Username</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>New password</TableHead>
            <TableHead>Access</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {owners.map((owner) => {
            const isSelf = owner.id === context.actor.userId;
            return (
              <TableRow key={owner.id} data-testid={`owner-row-${owner.username}`}>
                <TableCell className="font-medium">
                  {owner.name} {isSelf && <span className="text-muted-foreground">(you)</span>}
                </TableCell>
                <TableCell>{owner.username}</TableCell>
                <TableCell>
                  {owner.active ? <Badge variant="success">Active</Badge> : <Badge variant="destructive">Disabled</Badge>}
                </TableCell>
                <TableCell>
                  <ActionForm action={resetOwnerPasswordAction} resetOnSuccess className="flex flex-wrap items-center gap-2">
                    <input type="hidden" name="userId" value={owner.id} />
                    <Input
                      name="password"
                      type="password"
                      autoComplete="new-password"
                      placeholder="New password"
                      aria-label={`New password for ${owner.name}`}
                      className="h-8 w-40"
                      required
                    />
                    <SubmitButton variant="outline" size="sm">
                      Set password
                    </SubmitButton>
                  </ActionForm>
                </TableCell>
                <TableCell>
                  <ActionForm action={setOwnerDisabledAction} showSuccess={false}>
                    <input type="hidden" name="userId" value={owner.id} />
                    <input type="hidden" name="disabled" value={owner.active ? "true" : "false"} />
                    <SubmitButton variant={owner.active ? "destructive" : "outline"} size="sm">
                      {owner.active ? "Disable" : "Re-enable"}
                    </SubmitButton>
                  </ActionForm>
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>

      <Card>
        <CardHeader>
          <CardTitle>Add an owner</CardTitle>
          <CardDescription>The new owner can sign in straight away with the username and password you set.</CardDescription>
        </CardHeader>
        <CardContent>
          <ActionForm action={createOwnerAction} resetOnSuccess>
            <div className="grid gap-x-4 gap-y-1 md:grid-cols-3">
              <TextField name="name" label="Full name" autoComplete="off" required />
              <TextField
                name="username"
                label="Username"
                hint="Letters, numbers, dots, underscores"
                autoComplete="off"
                autoCapitalize="none"
                required
              />
              <TextField
                name="password"
                label="First password"
                type="password"
                hint="At least 8 characters"
                autoComplete="new-password"
                required
              />
            </div>
            <SubmitButton pendingLabel="Creating…" className="mt-2">Create owner account</SubmitButton>
          </ActionForm>
        </CardContent>
      </Card>

      <div className="flex flex-col gap-2">
        <h2 className="text-base font-semibold">Recent system activity</h2>
        <p className="text-sm text-muted-foreground">
          Changes to owners and businesses. What happens inside a business is in that business&apos;s own activity log.
        </p>
        <ActivityTable entries={activity} />
      </div>
    </div>
  );
}
