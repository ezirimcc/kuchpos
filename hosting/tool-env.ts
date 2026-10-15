import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

/** Loads the application folder's .env (the tools run from that folder) and says which site this is. */
export function loadToolEnv(): { site: "live" | "test"; appVersion: string } {
  const envFile = resolve(process.cwd(), ".env");
  if (existsSync(envFile)) process.loadEnvFile(envFile);
  const versionFile = resolve(process.cwd(), "VERSION.txt");
  const appVersion = existsSync(versionFile) ? readFileSync(versionFile, "utf8").split("\n")[0].trim() : "unknown";
  return { site: process.env.KUCHPOS_ENVIRONMENT === "test" ? "test" : "live", appVersion };
}

export function required(name: string, hint: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set in the .env file. ${hint}`);
  return value;
}

/** The shop's month, "2026-10" (Lagos is one hour ahead of universal time all year). */
export const lagosMonth = (at: Date = new Date()) => new Date(at.getTime() + 60 * 60 * 1000).toISOString().slice(0, 7);

/**
 * A database address from .env, checked with a message that names the line — most often
 * curly quotes or a space copied in from a document.
 */
export function databaseAddress(name: string): string {
  const value = required(name, "");
  if (!/^mysql:\/\/[^\s"'“”‘’]+$/.test(value)) {
    throw new Error(
      `The ${name} line in .env cannot be read. It must look like ${name}="mysql://USER:PASSWORD@localhost:3306/DATABASE" — ` +
        "straight quotes typed on the keyboard (not curly ones), no spaces, and a password of letters and numbers only.",
    );
  }
  return value;
}
