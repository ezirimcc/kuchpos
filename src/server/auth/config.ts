/** Automatic sign-out: the limits an admin may choose between, and the starting value for a new business. */
export const MIN_IDLE_SIGN_OUT_MINUTES = 5;
export const MAX_IDLE_SIGN_OUT_MINUTES = 8 * 60;
export const DEFAULT_IDLE_SIGN_OUT_MINUTES = 30;

/** Owners are not tied to one business, so their automatic sign-out time is fixed. */
export const OWNER_IDLE_SIGN_OUT_MINUTES = 30;

/**
 * The longest any session can sit unused: the top of the admin's range.
 * Each business's own (shorter) setting is enforced on every request in context.ts.
 */
export const SESSION_IDLE_SECONDS = MAX_IDLE_SIGN_OUT_MINUTES * 60;

/** A session's "last active" time is written at most this often, to avoid a database write on every click. */
export const LAST_ACTIVE_WRITE_INTERVAL_MS = 60 * 1000;

/** While someone is active, their session's expiry is pushed forward at most this often. */
export const SESSION_REFRESH_SECONDS = 5 * 60;

export const MIN_PASSWORD_LENGTH = 8;
export const MAX_PASSWORD_LENGTH = 128;
export const MIN_USERNAME_LENGTH = 3;
export const MAX_USERNAME_LENGTH = 30;

/** Lower-case letters, digits, dot and underscore. */
export const USERNAME_PATTERN = /^[a-z0-9._]+$/;

/**
 * The login library requires every user to have a unique email. Staff do not
 * need one, so each account gets a placeholder that can never receive mail.
 */
export function placeholderEmail(username: string): string {
  return `${username}@users.kuchpos.invalid`;
}
