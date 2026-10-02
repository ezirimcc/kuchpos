import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";

function git(...args: string[]): string[] {
  return execFileSync("git", args, { encoding: "utf8" })
    .split("\n")
    .filter(Boolean);
}

describe("secrets stay out of version control", () => {
  it("tracks no .env file other than .env.example", () => {
    const tracked = git("ls-files").filter(
      (file) => /(^|\/)\.env/.test(file) && !file.endsWith(".env.example"),
    );
    expect(tracked).toEqual([]);
  });

  it("ignores .env and its variants", () => {
    for (const file of [".env", ".env.local", ".env.production"]) {
      const ignored = git("check-ignore", "--no-index", file);
      expect(ignored, `${file} must be ignored by git`).toEqual([file]);
    }
  });

  it("does not ignore .env.example", () => {
    let ignored: string[] = [];
    try {
      ignored = git("check-ignore", "--no-index", ".env.example");
    } catch {
      // git exits with an error when the file is not ignored, which is what we want.
    }
    expect(ignored).toEqual([]);
  });

  it("tracks no private key or certificate files", () => {
    const tracked = git("ls-files").filter((file) => /\.(pem|key|p12|pfx)$/.test(file));
    expect(tracked).toEqual([]);
  });
});
