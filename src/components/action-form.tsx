"use client";

import { createContext, useActionState, useContext, useEffect, useId, useRef } from "react";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { type FormState, IDLE } from "@/lib/form-state";

type Action = (previous: FormState, formData: FormData) => Promise<FormState>;

const FormStateContext = createContext<{ state: FormState; pending: boolean }>({
  state: IDLE,
  pending: false,
});

/**
 * A form wired to a server action. Shows the action's message, marks fields
 * that need correcting, and stops a second submission while one is in flight.
 */
export function ActionForm({
  action,
  children,
  className,
  resetOnSuccess = false,
  showSuccess = true,
}: {
  action: Action;
  children: React.ReactNode;
  className?: string;
  resetOnSuccess?: boolean;
  showSuccess?: boolean;
}) {
  const [state, formAction, pending] = useActionState(action, IDLE);
  const formRef = useRef<HTMLFormElement>(null);

  useEffect(() => {
    if (state.status === "success" && resetOnSuccess) formRef.current?.reset();
  }, [state, resetOnSuccess]);

  return (
    <FormStateContext.Provider value={{ state, pending }}>
      <form ref={formRef} action={formAction} className={className}>
        {children}
        {state.status === "error" && (
          <Alert variant="destructive" className="mt-3">
            {state.message}
          </Alert>
        )}
        {state.status === "success" && showSuccess && (
          <Alert variant="success" className="mt-3">
            {state.message}
          </Alert>
        )}
      </form>
    </FormStateContext.Provider>
  );
}

function useFieldError(name: string): string | undefined {
  const { state } = useContext(FormStateContext);
  return state.status === "error" ? state.fieldErrors[name] : undefined;
}

export function TextField({
  name,
  label,
  hint,
  ...props
}: { name: string; label: string; hint?: string } & Omit<React.ComponentProps<"input">, "name">) {
  const id = useId();
  const error = useFieldError(name);
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Input id={id} name={name} aria-invalid={error ? true : undefined} aria-describedby={`${id}-help`} {...props} />
      <p id={`${id}-help`} className={error ? "text-xs text-destructive" : "text-xs text-muted-foreground"}>
        {error ?? hint ?? " "}
      </p>
    </div>
  );
}

export function SelectField({
  name,
  label,
  options,
  ...props
}: {
  name: string;
  label: string;
  options: { value: string; label: string }[];
} & Omit<React.ComponentProps<"select">, "name">) {
  const id = useId();
  const error = useFieldError(name);
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      <NativeSelect id={id} name={name} aria-invalid={error ? true : undefined} {...props}>
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </NativeSelect>
      <p className={error ? "text-xs text-destructive" : "text-xs text-muted-foreground"}>{error ?? " "}</p>
    </div>
  );
}

export function SubmitButton({
  children,
  pendingLabel = "Saving…",
  ...props
}: { pendingLabel?: string } & React.ComponentProps<typeof Button>) {
  const { pending } = useContext(FormStateContext);
  return (
    <Button type="submit" disabled={pending} {...props}>
      {pending ? pendingLabel : children}
    </Button>
  );
}
