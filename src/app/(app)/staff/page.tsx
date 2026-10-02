import type { Metadata } from "next";
import { ActionForm, SelectField, SubmitButton, TextField } from "@/components/action-form";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { NativeSelect } from "@/components/ui/native-select";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { requirePagePermission } from "@/server/auth/request";
import { listStaff } from "@/server/business/staff";
import { BUSINESS_ROLES, ROLE_LABELS } from "@/server/permissions";
import {
  createStaffAction,
  resetStaffPasswordAction,
  setStaffDisabledAction,
  setStaffRoleAction,
} from "./actions";

export const metadata: Metadata = { title: "Staff — KuchPos" };

const ROLE_OPTIONS = BUSINESS_ROLES.map((role) => ({ value: role, label: ROLE_LABELS[role] }));

export default async function StaffPage() {
  const context = await requirePagePermission("staff.manage");
  const staff = await listStaff(context);

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Staff</h1>
        <p className="text-sm text-muted-foreground">People who can sign in to {context.business?.name}.</p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Add a staff member</CardTitle>
          <CardDescription>
            Choose a username and a first password, and give both to the person. Usernames must be different from
            every other username in KuchPos.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ActionForm action={createStaffAction} resetOnSuccess>
            <div className="grid gap-x-4 gap-y-1 md:grid-cols-2 xl:grid-cols-4">
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
              <SelectField name="role" label="Role" options={ROLE_OPTIONS} defaultValue="CASHIER" />
            </div>
            <SubmitButton pendingLabel="Creating…" className="mt-2">Create staff account</SubmitButton>
          </ActionForm>
        </CardContent>
      </Card>

      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Name</TableHead>
            <TableHead>Username</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>Role</TableHead>
            <TableHead>New password</TableHead>
            <TableHead>Access</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {staff.map((person) => {
            const isSelf = person.id === context.actor.userId;
            return (
              <TableRow key={person.id} data-testid={`staff-row-${person.username}`}>
                <TableCell className="font-medium">
                  {person.name} {isSelf && <span className="text-muted-foreground">(you)</span>}
                </TableCell>
                <TableCell>{person.username}</TableCell>
                <TableCell>
                  {person.active ? <Badge variant="success">Active</Badge> : <Badge variant="destructive">Disabled</Badge>}
                </TableCell>
                <TableCell>
                  {isSelf ? (
                    ROLE_LABELS[person.role]
                  ) : (
                    <ActionForm action={setStaffRoleAction} showSuccess={false} className="flex flex-wrap items-center gap-2">
                      <input type="hidden" name="userId" value={person.id} />
                      <NativeSelect
                        name="role"
                        defaultValue={person.role}
                        aria-label={`Role of ${person.name}`}
                        className="h-8 w-36"
                      >
                        {ROLE_OPTIONS.map((option) => (
                          <option key={option.value} value={option.value}>
                            {option.label}
                          </option>
                        ))}
                      </NativeSelect>
                      <SubmitButton variant="outline" size="sm">
                        Save role
                      </SubmitButton>
                    </ActionForm>
                  )}
                </TableCell>
                <TableCell>
                  <ActionForm action={resetStaffPasswordAction} resetOnSuccess className="flex flex-wrap items-center gap-2">
                    <input type="hidden" name="userId" value={person.id} />
                    <Input
                      name="password"
                      type="password"
                      autoComplete="new-password"
                      placeholder="New password"
                      aria-label={`New password for ${person.name}`}
                      className="h-8 w-40"
                      required
                    />
                    <SubmitButton variant="outline" size="sm">
                      Set password
                    </SubmitButton>
                  </ActionForm>
                </TableCell>
                <TableCell>
                  {!isSelf && (
                    <ActionForm action={setStaffDisabledAction} showSuccess={false}>
                      <input type="hidden" name="userId" value={person.id} />
                      <input type="hidden" name="disabled" value={person.active ? "true" : "false"} />
                      <SubmitButton variant={person.active ? "destructive" : "outline"} size="sm">
                        {person.active ? "Disable" : "Re-enable"}
                      </SubmitButton>
                    </ActionForm>
                  )}
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}
