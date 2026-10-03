"use server";

import type { FormState } from "@/lib/form-state";
import { field, runAction } from "@/server/action";
import { setExpiringSoonMonths, setIdleSignOutMinutes, setReceiptText, setTaxRate } from "@/server/business/settings";
import { createTerminal, renameLocation, setTerminalActive, updateTerminal } from "@/server/business/setup";

export async function setIdleSignOutAction(_previous: FormState, formData: FormData): Promise<FormState> {
  return runAction({ success: "Automatic sign-out time saved." }, (context) =>
    setIdleSignOutMinutes(context, { minutes: field(formData, "minutes") }),
  );
}

export async function setTaxRateAction(_previous: FormState, formData: FormData): Promise<FormState> {
  return runAction({ success: "Tax rate saved. It applies to sales made from now on." }, (context) =>
    setTaxRate(context, { ratePercent: field(formData, "ratePercent") }),
  );
}

export async function setReceiptTextAction(_previous: FormState, formData: FormData): Promise<FormState> {
  return runAction({ success: "Receipt text saved." }, (context) =>
    setReceiptText(context, { header: field(formData, "header"), footer: field(formData, "footer") }),
  );
}

export async function renameLocationAction(_previous: FormState, formData: FormData): Promise<FormState> {
  return runAction({ success: "Location renamed." }, (context) =>
    renameLocation(context, { locationId: field(formData, "locationId"), name: field(formData, "name") }),
  );
}

export async function createTerminalAction(_previous: FormState, formData: FormData): Promise<FormState> {
  return runAction({ success: "Terminal added." }, (context) =>
    createTerminal(context, {
      code: field(formData, "code"),
      name: field(formData, "name"),
      paperWidth: field(formData, "paperWidth"),
    }),
  );
}

export async function updateTerminalAction(_previous: FormState, formData: FormData): Promise<FormState> {
  return runAction({ success: "Terminal saved." }, (context) =>
    updateTerminal(context, {
      terminalId: field(formData, "terminalId"),
      name: field(formData, "name"),
      paperWidth: field(formData, "paperWidth"),
    }),
  );
}

export async function setTerminalActiveAction(_previous: FormState, formData: FormData): Promise<FormState> {
  const active = field(formData, "active") === "true";
  return runAction({ success: active ? "Terminal brought back." : "Terminal taken out of use." }, (context) =>
    setTerminalActive(context, { terminalId: field(formData, "terminalId"), active }),
  );
}

export async function setExpiringSoonAction(_previous: FormState, formData: FormData): Promise<FormState> {
  return runAction({ success: "Saved." }, (context) =>
    setExpiringSoonMonths(context, { months: field(formData, "months") }),
  );
}
