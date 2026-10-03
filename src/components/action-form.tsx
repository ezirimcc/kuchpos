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
  compact = false,
}: {
  action: Action;
  children: React.ReactNode;
  className?: string;
  resetOnSuccess?: boolean;
  showSuccess?: boolean;
  /**
   * For small one-line forms built from plain inputs (no TextField): there is nowhere beside
   * the input to show what is wrong with it, so the specific problems are listed in the message.
   */
  compact?: boolean;
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
          <Alert variant="destructive" className={compact ? "basis-full" : "mt-3"}>
            {compact && Object.keys(state.fieldErrors).length > 0
              ? Object.values(state.fieldErrors).join(" ")
              : state.message}
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

export function TextAreaField({
  name,
  label,
  hint,
  ...props
}: { name: string; label: string; hint?: string } & Omit<React.ComponentProps<"textarea">, "name">) {
  const id = useId();
  const error = useFieldError(name);
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      <textarea
        id={id}
        name={name}
        aria-invalid={error ? true : undefined}
        className="min-h-20 w-full rounded-xl border border-input bg-background px-3 py-2 text-sm outline-none transition-colors placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 aria-invalid:border-destructive"
        {...props}
      />
      <p className={error ? "text-xs text-destructive" : "text-xs text-muted-foreground"}>{error ?? hint ?? "\u00a0"}</p>
    </div>
  );
}

export function CheckboxField({
  name,
  label,
  hint,
  ...props
}: { name: string; label: string; hint?: string } & Omit<React.ComponentProps<"input">, "name" | "type">) {
  const id = useId();
  const error = useFieldError(name);
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-2">
        <input id={id} name={name} type="checkbox" className="size-4 accent-primary" {...props} />
        <Label htmlFor={id}>{label}</Label>
      </div>
      {(error || hint) && (
        <p className={error ? "text-xs text-destructive" : "text-xs text-muted-foreground"}>{error ?? hint}</p>
      )}
    </div>
  );
}
