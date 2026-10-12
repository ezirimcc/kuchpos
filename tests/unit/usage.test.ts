import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Deleting a staff account (C67) is allowed only if no record carries that person's id.
 * The list of columns that carry one is written by hand in `src/server/usage.ts`; this test
 * reads the database schema and fails when a table gains such a column that the list lacks.
 */
describe("the columns that say who did something", () => {
  it("are all known to the check behind deleting a staff account", async () => {
    const { USER_COLUMNS } = await import("@/server/usage");
    const schema = readFileSync(join(process.cwd(), "prisma", "schema.prisma"), "utf8");
    const found: Record<string, string[]> = {};
    let model = "";
    for (const line of schema.split("\n")) {
      const start = /^model (\w+) \{/.exec(line);
      if (start) model = start[1].charAt(0).toLowerCase() + start[1].slice(1);
      const column = /^\s+(\w*[uU]serId)\s+String/.exec(line);
      if (column && model) (found[model] ??= []).push(column[1]);
    }
    // Not work done: being signed in, the sign-in record itself, the activity log (looked at
    // separately), and the error log (something going wrong on a person's screen is not their work).
    for (const name of ["session", "account", "activityLog", "errorLog"]) delete found[name];
    const sorted = (columns: Record<string, string[]>) => Object.fromEntries(Object.entries(columns).sort(([a], [b]) => a.localeCompare(b)).map(([name, list]) => [name, [...list].sort()]));
    expect(sorted(USER_COLUMNS)).toEqual(sorted(found));
  });
});
