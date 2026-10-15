import { afterEach, describe, expect, it } from "vitest";
import { databaseAddress } from "../../hosting/tool-env";

/** The host tools name the .env line that cannot be read (C79; a curly quote stopped the first drill). */
describe("a database address in .env", () => {
  afterEach(() => {
    delete process.env.RESTORE_DATABASE_URL;
  });

  it("is accepted as mysql://… and refused, naming the line, with curly quotes or spaces", () => {
    process.env.RESTORE_DATABASE_URL = "mysql://kuchcom_restore:abc123@localhost:3306/kuchcom_restore";
    expect(databaseAddress("RESTORE_DATABASE_URL")).toBe(process.env.RESTORE_DATABASE_URL);
    for (const bad of ["“mysql://u:p@localhost:3306/db”", "mysql://u:p@localhost:3306/ db", " mysql://u:p@localhost/db", "mariadb//u:p@localhost/db"]) {
      process.env.RESTORE_DATABASE_URL = bad;
      expect(() => databaseAddress("RESTORE_DATABASE_URL"), bad).toThrow(/The RESTORE_DATABASE_URL line in \.env cannot be read.*straight quotes/);
    }
  });
});
