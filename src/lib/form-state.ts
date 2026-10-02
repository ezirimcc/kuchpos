/** What a server action reports back to the form that called it. */
export type FormState =
  | { status: "idle" }
  | { status: "success"; message: string }
  | { status: "error"; message: string; fieldErrors: Record<string, string> };

export const IDLE: FormState = { status: "idle" };
