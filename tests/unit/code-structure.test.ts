import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

function filesUnder(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    return statSync(path).isDirectory() ? filesUnder(path) : [path];
  });
}

const appFiles = filesUnder("src/app").filter((file) => /\.(ts|tsx)$/.test(file));
const actionFiles = appFiles.filter((file) => /^\s*["']use server["']/.test(readFileSync(file, "utf8")));

describe("server actions", () => {
  it("finds the action files", () => {
    expect(actionFiles.length).toBeGreaterThan(0);
  });

  for (const file of actionFiles) {
    it(`${file}: every action identifies the signed-in person through runAction`, () => {
      const source = readFileSync(file, "utf8");
      const actions = source.split(/^export async function /m).slice(1);
      expect(actions.length).toBeGreaterThan(0);
      for (const body of actions) {
        const name = body.slice(0, body.indexOf("("));
        expect(body, `${name} must call runAction`).toContain("runAction(");
      }
    });

    it(`${file}: never takes the business from the submitted form`, () => {
      const source = readFileSync(file, "utf8");
      // An owner choosing which business to open or manage is the one legitimate use, in the owner area.
      if (file.includes(join("owner", "businesses"))) return;
      expect(source).not.toMatch(/businessId/);
    });
  }
});

describe("screens", () => {
  it("never import the database directly", () => {
    const offenders = appFiles.filter((file) => {
      if (file.includes(join("api", "health"))) return false;
      const source = readFileSync(file, "utf8");
      return /from "@\/server\/db\//.test(source) || /from "@\/generated\/prisma/.test(source);
    });
    expect(offenders).toEqual([]);
  });
});

describe("business operations", () => {
  const businessFiles = filesUnder("src/server/business").filter((file) => file.endsWith(".ts"));

  it("use only the business-scoped database client", () => {
    for (const file of businessFiles) {
      const source = readFileSync(file, "utf8");
      expect(source, file).not.toMatch(/@\/server\/db\/client/);
      expect(source, file).not.toMatch(/\$queryRaw|\$executeRaw/);
    }
  });

  it("check a permission in every exported operation", () => {
    for (const file of businessFiles) {
      const operations = readFileSync(file, "utf8").split(/^export async function /m).slice(1);
      for (const body of operations) {
        const name = body.slice(0, body.indexOf("("));
        expect(body, `${file}: ${name} must call authorize()`).toMatch(/\bauthorize\(context, "/);
      }
    }
  });
});

describe("owner operations", () => {
  it("check a permission in every exported operation", () => {
    for (const file of filesUnder("src/server/platform")) {
      const operations = readFileSync(file, "utf8").split(/^export async function /m).slice(1);
      for (const body of operations) {
        const name = body.slice(0, body.indexOf("("));
        expect(body, `${file}: ${name} must call authorize()`).toMatch(/\bauthorize\(context, "/);
      }
    }
  });
});
