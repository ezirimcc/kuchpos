import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";

/**
 * The few Backblaze B2 calls KuchPos's backups need (C79), with plain web requests — no
 * library. API version 4, as documented at backblaze.com/apidocs (checked 2026-10-14).
 *
 * The application key is made by the owner for ONE bucket, with the capabilities to list,
 * read and write files but NOT to delete them: old copies are removed by the bucket's own
 * lifecycle rules, so a stolen key could not erase the backups.
 */

const AUTHORIZE_URL = "https://api.backblazeb2.com/b2api/v4/b2_authorize_account";

export type B2Session = { apiUrl: string; downloadUrl: string; token: string; bucketId: string; bucketName: string };
type Fetch = typeof fetch;

async function answer<T>(response: Response, what: string): Promise<T> {
  if (response.ok) return (await response.json()) as T;
  let detail = "";
  try {
    const body = (await response.json()) as { code?: string; message?: string };
    detail = [body.code, body.message].filter(Boolean).join(": ");
  } catch {
    // Not JSON: the status says enough.
  }
  throw new Error(`Backblaze B2 refused to ${what} (${response.status}${detail ? ` — ${detail}` : ""}).`);
}

export async function b2Authorize(keyId: string, applicationKey: string, fetchFn: Fetch = fetch): Promise<B2Session> {
  const response = await fetchFn(AUTHORIZE_URL, { headers: { Authorization: `Basic ${Buffer.from(`${keyId}:${applicationKey}`).toString("base64")}` } });
  const body = await answer<{
    authorizationToken: string;
    apiInfo: { storageApi: { apiUrl: string; downloadUrl: string; allowed: { buckets?: { id: string; name: string | null }[] | null } } };
  }>(response, "accept the application key");
  const storage = body.apiInfo.storageApi;
  const buckets = storage.allowed.buckets ?? [];
  if (buckets.length !== 1 || !buckets[0].name) {
    throw new Error("The Backblaze B2 application key must be made for one bucket only (the KuchPos backups bucket).");
  }
  return { apiUrl: storage.apiUrl, downloadUrl: storage.downloadUrl, token: body.authorizationToken, bucketId: buckets[0].id, bucketName: buckets[0].name };
}

/** A file name as a URL path or header wants it: each part percent-encoded, the slashes kept. */
const encodeName = (name: string) => name.split("/").map(encodeURIComponent).join("/");

export async function b2Upload(session: B2Session, filePath: string, fileName: string, fetchFn: Fetch = fetch): Promise<void> {
  const body = await readFile(filePath);
  const sha1 = createHash("sha1").update(body).digest("hex");
  // An upload address can be refused once (busy or expired): fetch a fresh one and try again.
  for (let attempt = 1; ; attempt += 1) {
    const target = await answer<{ uploadUrl: string; authorizationToken: string }>(
      await fetchFn(`${session.apiUrl}/b2api/v4/b2_get_upload_url?bucketId=${encodeURIComponent(session.bucketId)}`, { headers: { Authorization: session.token } }),
      "give an upload address",
    );
    const response = await fetchFn(target.uploadUrl, {
      method: "POST",
      headers: {
        Authorization: target.authorizationToken,
        "X-Bz-File-Name": encodeName(fileName),
        "Content-Type": "application/octet-stream",
        "Content-Length": String(body.length),
        "X-Bz-Content-Sha1": sha1,
      },
      body,
    });
    if ((response.status === 401 || response.status === 503 || response.status === 408) && attempt < 3) continue;
    await answer(response, "store the backup");
    return;
  }
}

export type B2File = { fileName: string; uploadTimestamp: number; contentLength: number };

/** Every stored file whose name starts with one of the prefixes. */
export async function b2List(session: B2Session, prefixes: string[], fetchFn: Fetch = fetch): Promise<B2File[]> {
  const files: B2File[] = [];
  for (const prefix of prefixes) {
    let start: string | null = "";
    while (start !== null) {
      const params = new URLSearchParams({ bucketId: session.bucketId, prefix, maxFileCount: "1000", ...(start ? { startFileName: start } : {}) });
      const page: { files: (B2File & { action: string })[]; nextFileName: string | null } = await answer(
        await fetchFn(`${session.apiUrl}/b2api/v4/b2_list_file_names?${params}`, { headers: { Authorization: session.token } }),
        "list the backups",
      );
      files.push(...page.files.filter((file) => file.action === "upload").map(({ fileName, uploadTimestamp, contentLength }) => ({ fileName, uploadTimestamp, contentLength })));
      start = page.nextFileName;
    }
  }
  return files;
}

export async function b2Download(session: B2Session, fileName: string, toPath: string, fetchFn: Fetch = fetch): Promise<void> {
  const response = await fetchFn(`${session.downloadUrl}/file/${encodeURIComponent(session.bucketName)}/${encodeName(fileName)}`, { headers: { Authorization: session.token } });
  if (!response.ok) await answer(response, "hand back the backup");
  const body = Buffer.from(await response.arrayBuffer());
  const expected = response.headers.get("X-Bz-Content-Sha1");
  if (expected && expected !== "none" && createHash("sha1").update(body).digest("hex") !== expected) {
    throw new Error("The backup fetched from Backblaze B2 arrived damaged. Try again.");
  }
  await writeFile(toPath, body);
}
