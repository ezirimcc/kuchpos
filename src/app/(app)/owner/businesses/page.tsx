import type { Metadata } from "next";
import { ActionForm, SubmitButton, TextField } from "@/components/action-form";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { requirePagePermission } from "@/server/auth/request";
import { listBusinesses } from "@/server/platform/businesses";
import {
  createBusinessAction,
  openBusinessAction,
  renameBusinessAction,
  setBusinessActiveAction,
} from "./actions";

export const metadata: Metadata = { title: "Businesses — KuchPos" };

export default async function BusinessesPage() {
  const context = await requirePagePermission("business.manage");
  const businesses = await listBusinesses(context);

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Businesses</h1>
        <p className="text-sm text-muted-foreground">
          Each business is completely separate. Open one to work inside it with full admin rights.
        </p>
      </div>

      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Business</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>Accounts</TableHead>
            <TableHead>Rename</TableHead>
            <TableHead>Actions</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {businesses.map((business) => {
            const isOpen = context.business?.id === business.id;
            return (
              <TableRow key={business.id} data-testid={`business-row-${business.name}`}>
                <TableCell className="font-medium">
                  {business.name} {isOpen && <Badge className="ml-1">Open now</Badge>}
                </TableCell>
                <TableCell>
                  {business.active ? (
                    <Badge variant="success">Active</Badge>
                  ) : (
                    <Badge variant="destructive">Deactivated</Badge>
                  )}
                </TableCell>
                <TableCell>{business.staffCount}</TableCell>
                <TableCell>
                  <ActionForm action={renameBusinessAction} showSuccess={false} compact className="flex flex-wrap items-center gap-2">
                    <input type="hidden" name="businessId" value={business.id} />
                    <Input
                      name="name"
                      defaultValue={business.name}
                      aria-label={`New name for ${business.name}`}
                      className="h-8 w-56"
                      required
                    />
                    <SubmitButton variant="outline" size="sm">
                      Rename
                    </SubmitButton>
                  </ActionForm>
                </TableCell>
                <TableCell>
                  <div className="flex flex-wrap items-start gap-2">
                    {business.active && !isOpen && (
                      <ActionForm action={openBusinessAction} showSuccess={false}>
                        <input type="hidden" name="businessId" value={business.id} />
                        <SubmitButton size="sm" pendingLabel="Opening…">
                          Open
                        </SubmitButton>
                      </ActionForm>
                    )}
                    <ActionForm action={setBusinessActiveAction} showSuccess={false}>
                      <input type="hidden" name="businessId" value={business.id} />
                      <input type="hidden" name="active" value={business.active ? "false" : "true"} />
                      <SubmitButton variant={business.active ? "destructive" : "outline"} size="sm">
                        {business.active ? "Deactivate" : "Reactivate"}
                      </SubmitButton>
                    </ActionForm>
                  </div>
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
      {businesses.length === 0 && <p className="text-sm text-muted-foreground">No businesses yet. Create the first one below.</p>}

      <Card>
        <CardHeader>
          <CardTitle>Create a business</CardTitle>
          <CardDescription>
            A new business starts empty. It needs one admin, who can then add the rest of the staff.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ActionForm action={createBusinessAction} resetOnSuccess>
            <div className="grid gap-x-4 gap-y-1 md:grid-cols-2 xl:grid-cols-4">
              <TextField name="name" label="Business name" autoComplete="off" required />
              <TextField name="adminName" label="Admin's full name" autoComplete="off" required />
              <TextField
                name="adminUsername"
                label="Admin's username"
                hint="Letters, numbers, dots, underscores"
                autoComplete="off"
                autoCapitalize="none"
                required
              />
              <TextField
                name="adminPassword"
                label="Admin's first password"
                type="password"
                hint="At least 8 characters"
                autoComplete="new-password"
                required
              />
            </div>
            <SubmitButton pendingLabel="Creating…" className="mt-2">Create business</SubmitButton>
          </ActionForm>
        </CardContent>
      </Card>
    </div>
  );
}
