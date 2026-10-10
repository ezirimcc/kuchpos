import { Settings } from "lucide-react";
import type { Metadata } from "next";
import { ActionForm, CheckboxField, SelectField, SubmitButton, TextAreaField, TextField } from "@/components/action-form";
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
import { listPaymentMethods } from "@/server/business/payment-methods";
import { PAYMENT_KINDS, paymentKindLabel } from "@/lib/payment-kinds";
import { getSetup } from "@/server/business/setup";
import {
  createTerminalAction,
  renameLocationAction,
  setExpiringSoonAction,
  setIdleSignOutAction,
  createPaymentMethodAction,
  renamePaymentMethodAction,
  setPaymentMethodActiveAction,
  setReceiptPrintingAction,
  setReturnDaysAction,
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

const PAYMENT_KIND_OPTIONS = PAYMENT_KINDS.map((kind) => ({ value: kind.value, label: kind.label }));

export default async function SettingsPage() {
  const context = await requirePagePermission("settings.manage");
  const [settings, setup, paymentMethods] = await Promise.all([
    getBusinessSettings(context),
    getSetup(context),
    listPaymentMethods(context),
  ]);

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
            <div className="max-w-sm">
              <TextField
                name="taxNumber"
                label="Tax number (TIN), optional"
                hint="Printed on receipts only if filled in"
                defaultValue={settings.taxNumber}
                maxLength={40}
                autoComplete="off"
              />
            </div>
            <SubmitButton className="mt-2">Save receipt text</SubmitButton>
          </ActionForm>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Printing</CardTitle>
          <CardDescription>What happens to the receipt when a sale is completed, on every checkout of this business.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <ActionForm action={setReceiptPrintingAction}>
            <CheckboxField
              name="autoPrint"
              label="Print the receipt automatically after each sale"
              hint="If this is not ticked, the sale ends on the receipt with a Print receipt button and a New sale button."
              defaultChecked={settings.autoPrintReceipts}
            />
            <SubmitButton className="mt-2">Save printing setting</SubmitButton>
          </ActionForm>
          <div className="max-w-3xl rounded-2xl bg-muted/50 p-4 text-sm" data-testid="printer-help">
            <p className="font-medium">Which printer is used</p>
            <p className="mt-1 text-muted-foreground">
              KuchPos cannot choose the printer: a website is not allowed to. The browser prints to the printer chosen on that
              checkout computer. Set it once on each checkout computer:
            </p>
            <ol className="mt-2 list-decimal space-y-1 pl-5 text-muted-foreground">
              <li>
                In Windows open <span className="text-foreground">Settings → Bluetooth &amp; devices → Printers &amp; scanners</span>. Switch off
                &quot;Let Windows manage my default printer&quot;, click the receipt printer, then <span className="text-foreground">Set as default</span>.
              </li>
              <li>
                The first time a receipt prints, the browser&apos;s print window opens. Choose the receipt printer as the Destination; the
                browser remembers it.
              </li>
              <li>
                To print without that window appearing at all, start Chrome or Edge from a shortcut with{" "}
                <code className="rounded bg-background px-1">--kiosk-printing</code> added to the end of its Target. It then prints straight to
                the default printer.
              </li>
            </ol>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Payment methods</CardTitle>
          <CardDescription>
            The ways your customers pay, chosen at checkout. Name each one so staff recognise it, for example
            &quot;Transfer – GTBank&quot; or &quot;POS – Moniepoint&quot;. The kind cannot be changed later: it decides
            what counts as cash in the till. A method that is switched off is no longer offered, but past sales keep it.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Kind</TableHead>
                <TableHead>Status</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {paymentMethods.map((method) => (
                <TableRow key={method.id} data-testid={`payment-method-${method.name}`}>
                  <TableCell>
                    <ActionForm action={renamePaymentMethodAction} showSuccess={false} compact className="flex flex-wrap items-center gap-2">
                      <input type="hidden" name="methodId" value={method.id} />
                      <Input name="name" defaultValue={method.name} aria-label={`Name of payment method ${method.name}`} className="h-8 w-56" maxLength={60} required />
                      <SubmitButton variant="outline" size="sm">
                        Save
                      </SubmitButton>
                    </ActionForm>
                  </TableCell>
                  <TableCell>{paymentKindLabel(method.kind)}</TableCell>
                  <TableCell>
                    {method.active ? <Badge variant="success">In use</Badge> : <Badge variant="destructive">Switched off</Badge>}
                  </TableCell>
                  <TableCell>
                    {method.builtIn ? (
                      <span className="text-xs text-muted-foreground">Always available</span>
                    ) : (
                      <ActionForm action={setPaymentMethodActiveAction} showSuccess={false}>
                        <input type="hidden" name="methodId" value={method.id} />
                        <input type="hidden" name="active" value={method.active ? "false" : "true"} />
                        <SubmitButton variant={method.active ? "destructive" : "outline"} size="sm">
                          {method.active ? "Switch off" : "Switch on"}
                        </SubmitButton>
                      </ActionForm>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>

          <h3 className="mt-5 mb-2 text-sm font-medium">Add a payment method</h3>
          <ActionForm action={createPaymentMethodAction} resetOnSuccess>
            <div className="grid gap-x-4 gap-y-1 md:grid-cols-2">
              <TextField name="name" label="Name of the new method" hint="For example: Transfer – GTBank" autoComplete="off" maxLength={60} required />
              <SelectField name="kind" label="Kind" options={PAYMENT_KIND_OPTIONS} defaultValue="TRANSFER" />
            </div>
            <SubmitButton pendingLabel="Adding…">Add payment method</SubmitButton>
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
          <CardTitle>Returns</CardTitle>
          <CardDescription>
            How long after a sale its goods may still be brought back. After that the system refuses the return. A return always
            needs a reason, and a cashier&apos;s return needs a manager&apos;s approval.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ActionForm action={setReturnDaysAction}>
            <div className="max-w-xs">
              <TextField
                name="days"
                label="Days allowed for a return"
                type="number"
                inputMode="numeric"
                min={0}
                max={3650}
                step={1}
                defaultValue={settings.returnDays}
                key={settings.returnDays}
                hint="0 means no limit"
                required
              />
            </div>
            <SubmitButton className="mt-2">Save days allowed</SubmitButton>
          </ActionForm>
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
