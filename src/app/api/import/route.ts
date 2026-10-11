import { IMPORT_MAX_BYTES } from "@/lib/import-template";
import { previewHistoryImport, runHistoryImport } from "@/server/business/import-history";
import { previewSetupImport, runSetupImport } from "@/server/business/imports";
import { ValidationError } from "@/server/errors";
import { answerFromOwnPages } from "@/server/passive";

/**
 * The Import screen sends the shop's Excel workbook here: first to be checked ("preview",
 * which saves nothing), then to be brought in ("run"). Who may do it, and everything about
 * the file, is checked by the operations; this only takes the upload apart.
 */
export async function POST(request: Request): Promise<Response> {
  return answerFromOwnPages(request, async (context) => {
    const tooLarge = new ValidationError("That file is larger than 5 MB. An import workbook is far smaller: check that you chose the right file.");
    // Refused before the upload is read into memory. (The form's other fields add a little to the length.)
    const length = request.headers.get("content-length");
    if (length && /^\d+$/.test(length) && BigInt(length) > BigInt(IMPORT_MAX_BYTES + 64 * 1024)) throw tooLarge;
    const form = await request.formData().catch(() => null);
    const file = form?.get("file");
    if (!form || !(file instanceof File)) throw new ValidationError("Choose the Excel file to bring in.");
    if (file.size > IMPORT_MAX_BYTES) throw tooLarge;
    const input = { fileName: file.name, startingDay: String(form.get("startingDay") ?? "") };
    const bytes = Buffer.from(await file.arrayBuffer());
    // Which sheets: Products, Customers and Stock ("setup"), or Deliveries and Sales ("history").
    const history = form.get("part") === "history";
    if (form.get("mode") === "run") {
      const done = history ? await runHistoryImport(context, input, bytes) : await runSetupImport(context, input, bytes);
      return { done: true, number: done.number, exceptions: "exceptions" in done ? done.exceptions : 0, preview: done.preview };
    }
    return { done: false, preview: history ? await previewHistoryImport(context, input, bytes) : await previewSetupImport(context, input, bytes) };
  });
}
