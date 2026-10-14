import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { b2Authorize, b2Download, b2List, b2Upload, type B2Session } from "../../hosting/b2";

/**
 * The Backblaze B2 calls (C79), against a stand-in that answers as the v4 API documents.
 * Nothing goes over the internet.
 */

type Call = { url: string; init?: RequestInit };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const session: B2Session = { apiUrl: "https://api001.backblazeb2.com", downloadUrl: "https://f001.backblazeb2.com", token: "account-token", bucketId: "bucket-1", bucketName: "kuchpos-backups" };
const folder = mkdtempSync(join(tmpdir(), "kuchpos-b2-"));

describe("Backblaze B2", () => {
  it("signs in with the key and finds the one bucket it is for", async () => {
    const calls: Call[] = [];
    const fake = async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      return json({ authorizationToken: "account-token", apiInfo: { storageApi: { apiUrl: session.apiUrl, downloadUrl: session.downloadUrl, allowed: { buckets: [{ id: "bucket-1", name: "kuchpos-backups" }], capabilities: ["listFiles", "readFiles", "writeFiles"] } } } });
    };
    expect(await b2Authorize("key-id", "secret", fake as typeof fetch)).toEqual(session);
    expect(calls[0].url).toBe("https://api.backblazeb2.com/b2api/v4/b2_authorize_account");
    expect((calls[0].init?.headers as Record<string, string>).Authorization).toBe(`Basic ${Buffer.from("key-id:secret").toString("base64")}`);

    const allBuckets = async () => json({ authorizationToken: "t", apiInfo: { storageApi: { apiUrl: "a", downloadUrl: "d", allowed: { buckets: null } } } });
    await expect(b2Authorize("key-id", "secret", allBuckets as typeof fetch)).rejects.toThrow(/one bucket only/);
    const refused = async () => json({ code: "unauthorized", message: "bad key" }, 401);
    await expect(b2Authorize("key-id", "wrong", refused as typeof fetch)).rejects.toThrow(/refused to accept the application key \(401 — unauthorized: bad key\)/);
  });

  it("uploads the file with its checksum, and asks for a fresh upload address once when busy", async () => {
    const file = join(folder, "backup.kbk");
    writeFileSync(file, "encrypted bytes");
    const calls: Call[] = [];
    let uploads = 0;
    const fake = async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      if (String(url).includes("b2_get_upload_url")) return json({ bucketId: "bucket-1", uploadUrl: `https://pod-1.backblaze.com/upload/${calls.length}`, authorizationToken: `upload-token-${calls.length}` });
      uploads += 1;
      return uploads === 1 ? json({ code: "service_unavailable" }, 503) : json({ fileId: "f1", fileName: "nightly/backup.kbk" });
    };
    await b2Upload(session, file, "nightly/kuchpos live.kbk", fake as typeof fetch);
    expect(calls.map((call) => call.url)).toEqual([
      "https://api001.backblazeb2.com/b2api/v4/b2_get_upload_url?bucketId=bucket-1",
      "https://pod-1.backblaze.com/upload/1",
      "https://api001.backblazeb2.com/b2api/v4/b2_get_upload_url?bucketId=bucket-1",
      "https://pod-1.backblaze.com/upload/3",
    ]);
    const headers = calls[3].init?.headers as Record<string, string>;
    expect(headers).toMatchObject({
      Authorization: "upload-token-3",
      "X-Bz-File-Name": "nightly/kuchpos%20live.kbk",
      "Content-Length": "15",
      "X-Bz-Content-Sha1": createHash("sha1").update("encrypted bytes").digest("hex"),
    });
  });

  it("lists every page of stored files, leaving out hidden ones", async () => {
    const fake = async (url: string | URL | Request) => {
      const params = new URL(String(url)).searchParams;
      if (params.get("prefix") === "nightly/" && !params.get("startFileName")) {
        return json({ files: [{ action: "upload", fileName: "nightly/a.kbk", uploadTimestamp: 1, contentLength: 5 }, { action: "hide", fileName: "nightly/old.kbk", uploadTimestamp: 0, contentLength: 0 }], nextFileName: "nightly/b.kbk" });
      }
      if (params.get("prefix") === "nightly/") return json({ files: [{ action: "upload", fileName: "nightly/b.kbk", uploadTimestamp: 2, contentLength: 6 }], nextFileName: null });
      return json({ files: [], nextFileName: null });
    };
    expect((await b2List(session, ["daytime/", "nightly/"], fake as typeof fetch)).map((file) => file.fileName)).toEqual(["nightly/a.kbk", "nightly/b.kbk"]);
  });

  it("downloads a file and refuses one that arrived damaged", async () => {
    const good = async () => new Response("the bytes", { headers: { "X-Bz-Content-Sha1": createHash("sha1").update("the bytes").digest("hex") } });
    await b2Download(session, "nightly/a.kbk", join(folder, "a.kbk"), good as typeof fetch);
    expect(readFileSync(join(folder, "a.kbk"), "utf8")).toBe("the bytes");
    const bad = async () => new Response("other bytes", { headers: { "X-Bz-Content-Sha1": createHash("sha1").update("the bytes").digest("hex") } });
    await expect(b2Download(session, "nightly/a.kbk", join(folder, "b.kbk"), bad as typeof fetch)).rejects.toThrow(/arrived damaged/);
  });
});
