import { TextField } from "@/components/action-form";

/** The boxes for a customer's details (SPEC C49): name and phone are required, the rest optional. */
export function CustomerFields({ values }: { values?: { name: string; phone: string; address: string | null; city: string | null; state: string | null } }) {
  return (
    <div className="grid gap-x-4 gap-y-1 md:grid-cols-2">
      <TextField name="name" label="Name" defaultValue={values?.name} maxLength={120} autoComplete="off" required />
      <TextField name="phone" label="Phone number" hint="Digits only, for example 08031234567" defaultValue={values?.phone} inputMode="tel" maxLength={30} autoComplete="off" required />
      <div className="md:col-span-2">
        <TextField name="address" label="Address (optional)" defaultValue={values?.address ?? ""} maxLength={200} autoComplete="off" />
      </div>
      <TextField name="city" label="City (optional)" defaultValue={values?.city ?? ""} maxLength={60} autoComplete="off" />
      <TextField name="state" label="State (optional)" defaultValue={values?.state ?? ""} maxLength={60} autoComplete="off" />
    </div>
  );
}
