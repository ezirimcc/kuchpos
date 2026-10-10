import { ArrowLeft, Undo2 } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { PageHeader } from "@/components/page-header";
import { Alert } from "@/components/ui/alert";
import { formatDateTime, returnNumber } from "@/lib/format";
import { requirePageContext } from "@/server/auth/request";
import { getReturn } from "@/server/business/returns";
import { ForbiddenError, NotFoundError, ValidationError } from "@/server/errors";
import { ReturnSlip } from "../return-slip";

export const metadata: Metadata = { title: "Return — KuchPos" };

export default async function ReturnPage({ params, searchParams }: PageProps<"/returns/[returnId]">) {
  const context = await requirePageContext();
  const { returnId } = await params;
  const justSaved = (await searchParams).done === "1";

  let slip: Awaited<ReturnType<typeof getReturn>>;
  try {
    slip = await getReturn(context, { returnId });
  } catch (error) {
    if (error instanceof ForbiddenError) redirect("/");
    if (error instanceof NotFoundError || error instanceof ValidationError) notFound();
    throw error;
  }

  return (
    <div className="flex max-w-5xl flex-col gap-5">
      <Link href="/returns" className="flex items-center gap-1 text-sm text-muted-foreground underline-offset-4 hover:underline">
        <ArrowLeft className="size-3.5" aria-hidden /> Returns
      </Link>
      <PageHeader
        icon={Undo2}
        title={`Return ${returnNumber(slip.number)}`}
        description={`${formatDateTime(slip.createdAt)} · taken back by ${slip.createdByName} · against sale ${slip.sale.receiptNumber} · a saved return is never changed.`}
      />
      {justSaved && (
        <Alert data-testid="return-saved">
          The return is saved.{" "}
          {slip.refundPaid !== "0.00" ? `Hand the customer their money back (${slip.refundMethodName}).` : "Nothing is handed back: it came off what the customer owes."}
        </Alert>
      )}
      <ReturnSlip slip={slip} justSaved={justSaved} />
    </div>
  );
}
