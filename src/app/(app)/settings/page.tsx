import { Settings } from "lucide-react";
import type { Metadata } from "next";
import { ActionForm, SelectField, SubmitButton, TextAreaField, TextField } from "@/components/action-form";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatDateTime, plainNumber } from "@/lib/format";
import { MAX_IDLE_SIGN_OUT_MINUTES, MIN_IDLE_SIGN_OUT_MINUTES } from "@/server/auth/config";
import { PageHeader } from "@/components/page-header";
import { requirePagePermission } from "@/server/auth/request";
import { getBusinessSettings } from "@/server/business/settings";
import { getSetup } from "@/server/business/setup";
import {
  createTerminalAction,
  renameLocationAction,
  setExpiringSoonAction,
  setIdleSignOutAction,
  setReceiptTextAction,
  setTaxRateAction,
  setTerminalActiveAction,
  updateTerminalAction,
} from "./actions";

export const metadata: Metadata = { title: "Settings — KuchPos" };

const PAPER_OPTIONS = [
  { value: "MM80", label: "80 mm" },
  { value: "MM58", label: "58 mm" },
];

export default async function SettingsPage() {
  const context = await requirePagePermission("settings.manage");
  const [settings, setup] = await Promise.all([getBusinessSettings(context), getSetup(context)]);

  return (
    <div className="flex max-w-4xl flex-col gap-6">
      <PageHeader icon={Settings} title="Settings" description={<>Settings for {settings.name}.</>} />

      <Card>
        <CardHeader>
          <CardTitle>Tax rate</CardTitle>
          <CardDescription>
            Prices already include tax. This rate says how much of each taxable price is tax, and it is shown on
            receipts when above 0%. A change applies to sales made from now on; past sales keep the rate they were sold
            at. Changing it does not change what customers pay.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ActionForm action={setTaxRateAction}>
            <div className="max-w-xs">
              <TextField
                name="ratePercent"
                label="Tax rate (%)"
                inputMode="decimal"
                autoComplete="off"
                defaultValue={plainNumber(settings.taxRatePercent)}
                key={settings.taxRatePercent}
                hint="From 0 to 100, for example 0 or 7.5"
                required
              />
            </div>
            <SubmitButton className="mt-2">Save tax rate</SubmitButton>
          </ActionForm>
          {settings.taxRateHistory.length > 0 && (
            <div className="mt-5">
              <h3 className="mb-1 text-sm font-medium">Changes so far</h3>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>When</TableHead>
                    <TableHead>From</TableHead>
                    <TableHead>To</TableHead>
                    <TableHead>Changed by</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {settings.taxRateHistory.map((entry) => (
                    <TableRow key={entry.id} data-testid="tax-history-row">
                      <TableCell className="whitespace-nowrap text-muted-foreground">{formatDateTime(entry.createdAt)}</TableCell>
                      <TableCell>{plainNumber(entry.oldRatePercent)}%</TableCell>
                      <TableCell className="font-medium">{plainNumber(entry.newRatePercent)}%</TableCell>
                      <TableCell>{entry.changedByName}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Receipt text</CardTitle>
          <CardDescription>
            The business name is printed automatically. Add the lines you want under it, and at the bottom of every
            receipt.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ActionForm action={setReceiptTextAction}>
            <div className="grid gap-x-4 gap-y-1 md:grid-cols-2">
              <TextAreaField
                name="header"
                label="Top of receipt"
                hint="For example the address and phone number"
                defaultValue={settings.receiptHeader}
                maxLength={500}
              />
              <TextAreaField
                name="footer"
                label="Bottom of receipt"
                hint="For example a thank-you line or return policy"
                defaultValue={settings.receiptFooter}
                maxLength={500}
              />
            </div>
            <SubmitButton className="mt-2">Save receipt text</SubmitButton>
          </ActionForm>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Checkout terminals</CardTitle>
          <CardDescription>
            One entry for each checkout computer. The code starts every receipt number that computer produces and can
            never be changed. Choose the paper width of the receipt printer attached to it.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Code</TableHead>
                <TableHead>Name and receipt paper</TableHead>
                <TableHead>Status</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {setup.terminals.map((terminal) => (
                <TableRow key={terminal.id} data-testid={`terminal-row-${terminal.code}`}>
                  <TableCell className="font-medium">{terminal.code}</TableCell>
                  <TableCell>
                    <ActionForm action={updateTerminalAction} showSuccess={false} compact className="flex flex-wrap items-center gap-2">
                      <input type="hidden" name="terminalId" value={terminal.id} />
                      <Input name="name" defaultValue={terminal.name} aria-label={`Name of terminal ${terminal.code}`} className="h-8 w-48" required />
                      <NativeSelect
                        name="paperWidth"
                        defaultValue={terminal.paperWidth}
                        aria-label={`Receipt paper of terminal ${terminal.code}`}
                        className="h-8 w-28"
                      >
                        {PAPER_OPTIONS.map((option) => (
                          <option key={option.value} value={option.value}>
                            {option.label}
                          </option>
                        ))}
                      </NativeSelect>
                      <SubmitButton variant="outline" size="sm">
                        Save
                      </SubmitButton>
                    </ActionForm>
                  </TableCell>
                  <TableCell>
                    {terminal.active ? <Badge variant="success">In use</Badge> : <Badge variant="destructive">Out of use</Badge>}
                  </TableCell>
                  <TableCell>
                    <ActionForm action={setTerminalActiveAction} showSuccess={false}>
                      <input type="hidden" name="terminalId" value={terminal.id} />
                      <input type="hidden" name="active" value={terminal.active ? "false" : "true"} />
                      <SubmitButton variant={terminal.active ? "destructive" : "outline"} size="sm">
                        {terminal.active ? "Take out of use" : "Bring back"}
                      </SubmitButton>
                    </ActionForm>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>

          <h3 className="mt-5 mb-2 text-sm font-medium">Add a terminal</h3>
          <ActionForm action={createTerminalAction} resetOnSuccess>
            <div className="grid gap-x-4 gap-y-1 md:grid-cols-3">
              <TextField name="code" label="Code" hint="1 to 6 letters or numbers, for example T2" autoComplete="off" autoCapitalize="characters" required />
              <TextField name="name" label="Name" hint="For example: Front checkout" autoComplete="off" required />
              <SelectField name="paperWidth" label="Receipt paper" options={PAPER_OPTIONS} defaultValue="MM80" />
            </div>
            <SubmitButton pendingLabel="Adding…">Add terminal</SubmitButton>
          </ActionForm>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Stock locations</CardTitle>
          <CardDescription>Where stock is kept. Every business has a shelf and a storeroom; you can rename them.</CardDescription>
        </CardHeader>
        <CardContent>
          <Table>
            <TableBody>
              {setup.locations.map((location) => (
                <TableRow key={location.id} data-testid={`location-row-${location.kind}`}>
                  <TableCell className="w-40 text-muted-foreground">{location.kind === "SHELF" ? "Shelf" : "Storeroom"}</TableCell>
                  <TableCell>
                    <ActionForm action={renameLocationAction} showSuccess={false} compact className="flex flex-wrap items-center gap-2">
                      <input type="hidden" name="locationId" value={location.id} />
                      <Input name="name" defaultValue={location.name} aria-label={`Name of the ${location.kind.toLowerCase()}`} className="h-8 w-56" required />
                      <SubmitButton variant="outline" size="sm">
                        Rename
                      </SubmitButton>
                    </ActionForm>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Expiring soon</CardTitle>
          <CardDescription>
            How far ahead the “Expiring soon” list looks. A delivery whose expiry date falls within this many months
            is listed there.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ActionForm action={setExpiringSoonAction}>
            <div className="max-w-xs">
              <TextField
                name="months"
                label="Months ahead"
                type="number"
                inputMode="numeric"
                min={1}
                max={36}
                step={1}
                defaultValue={settings.expiringSoonMonths}
                key={settings.expiringSoonMonths}
                hint="From 1 to 36 months"
                required
              />
            </div>
            <SubmitButton className="mt-2">Save expiring-soon period</SubmitButton>
          </ActionForm>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Automatic sign-out</CardTitle>
          <CardDescription>
            If a signed-in screen is not used for this long, it asks for the password again. A shorter time is safer
            on a computer that several people share.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ActionForm action={setIdleSignOutAction}>
            <div className="max-w-xs">
              <TextField
                name="minutes"
                label="Minutes without use"
                type="number"
                inputMode="numeric"
                min={MIN_IDLE_SIGN_OUT_MINUTES}
                max={MAX_IDLE_SIGN_OUT_MINUTES}
                step={1}
                defaultValue={settings.idleSignOutMinutes}
                key={settings.idleSignOutMinutes}
                hint={`From ${MIN_IDLE_SIGN_OUT_MINUTES} to ${MAX_IDLE_SIGN_OUT_MINUTES} minutes (8 hours)`}
                required
              />
            </div>
            <SubmitButton className="mt-2">Save sign-out time</SubmitButton>
          </ActionForm>
        </CardContent>
      </Card>
    </div>
  );
}
