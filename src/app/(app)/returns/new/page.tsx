import { ArrowLeft, Undo2 } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { PageHeader } from "@/components/page-header";
import { Alert } from "@/components/ui/alert";
import { formatDateTime, nairaFromText, returnNumber } from "@/lib/format";
import { requirePagePermission } from "@/server/auth/request";
import { getReturnOptions, type ReturnOptions } from "@/server/business/returns";
import { NotFoundError, ValidationError } from "@/server/errors";
import { ReturnForm } from "../return-form";

export const metadata: Metadata = { title: "Return goods — KuchPos" };

function text(value: string | string[] | undefined): string {
  return typeof value === "string" ? value : "";
}

export default async function NewReturnPage({ searchParams }: PageProps<"/returns/new">) {
  const context = await requirePagePermission("return.request");
  const params = await searchParams;
  const saleId = text(params.sale);
  const receiptNumber = text(params.receipt).trim().toUpperCase();
  if (!saleId && !receiptNumber) redirect("/returns");

  let options: ReturnOptions;
  try {
    options = await getReturnOptions(context, { saleId, receiptNumber });
  } catch (error) {
    // Nothing found under that number: back to the box, saying so.
    if (error instanceof NotFoundError || error instanceof ValidationError) redirect(`/returns?notfound=${encodeURIComponent(receiptNumber || "that sale")}`);
    throw error;
  }

  return (
    <div className="flex flex-col gap-5">
      <Link href="/returns" className="flex items-center gap-1 text-sm text-muted-foreground underline-offset-4 hover:underline">
        <ArrowLeft className="size-3.5" aria-hidden /> Returns
      </Link>
      <PageHeader
        icon={Undo2}
        title={`Return goods from sale ${options.sale.receiptNumber}`}
        description={
          <>
            Sold on {formatDateTime(options.sale.soldAt)} by {options.sale.cashierName}
            {options.sale.customerName ? ` to ${options.sale.customerName}` : ""}. Enter how many of each item came back and where they go.
          </>
        }
      />
      {options.earlier.length > 0 && (
        <p className="text-sm text-muted-foreground" data-testid="earlier-returns">
          Already returned from this sale:{" "}
          {options.earlier.map((entry, index) => (
            <span key={entry.id}>
              {index > 0 ? ", " : ""}
              <Link href={`/returns/${entry.id}`} className="text-link underline-offset-4 hover:underline">
                {returnNumber(entry.number)}
              </Link>{" "}
              ({nairaFromText(entry.refundTotal)})
            </span>
          ))}
        </p>
      )}
      {options.blocked ? (
        <Alert variant="destructive" data-testid="return-blocked">
          {options.blocked}
        </Alert>
      ) : (
        <ReturnForm options={options} />
      )}
    </div>
  );
}
