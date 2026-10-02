import type { Metadata } from "next";
import { ActionForm, SubmitButton, TextField } from "@/components/action-form";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { MAX_IDLE_SIGN_OUT_MINUTES, MIN_IDLE_SIGN_OUT_MINUTES } from "@/server/auth/config";
import { requirePagePermission } from "@/server/auth/request";
import { getBusinessSettings } from "@/server/business/settings";
import { setIdleSignOutAction } from "./actions";

export const metadata: Metadata = { title: "Settings — KuchPos" };

export default async function SettingsPage() {
  const context = await requirePagePermission("settings.manage");
  const settings = await getBusinessSettings(context);

  return (
    <div className="flex max-w-2xl flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
        <p className="text-sm text-muted-foreground">Settings for {settings.name}. More will appear here as KuchPos grows.</p>
      </div>

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
            <SubmitButton className="mt-2">Save</SubmitButton>
          </ActionForm>
        </CardContent>
      </Card>
    </div>
  );
}
