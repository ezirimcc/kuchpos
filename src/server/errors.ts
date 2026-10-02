/**
 * Errors whose message is safe and useful to show to staff.
 * Anything else that goes wrong is logged and shown as a generic message.
 */
export class AppError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export type SignedOutReason = "none" | "idle" | "disabled";

/** Nobody is signed in, or the session is no longer valid. */
export class NotSignedInError extends AppError {
  readonly reason: SignedOutReason;

  constructor(message = "Please sign in to continue.", reason: SignedOutReason = "none") {
    super(message);
    this.reason = reason;
  }
}

/** Signed in, but not allowed to do this. */
export class ForbiddenError extends AppError {
  constructor(message = "You do not have permission to do this.") {
    super(message);
  }
}

/** The record does not exist — or belongs to another business, which is reported the same way. */
export class NotFoundError extends AppError {
  constructor(message = "That record could not be found.") {
    super(message);
  }
}

/** The input was understood but cannot be accepted. `fieldErrors` maps a field name to its problem. */
export class ValidationError extends AppError {
  readonly fieldErrors: Record<string, string>;

  constructor(message: string, fieldErrors: Record<string, string> = {}) {
    super(message);
    this.fieldErrors = fieldErrors;
  }
}
