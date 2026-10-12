import "server-only";

/** Noting an unexpected failure in the app's own error log (C68). See `db/error-record.ts`. */
export { recordError } from "./db/error-record";
