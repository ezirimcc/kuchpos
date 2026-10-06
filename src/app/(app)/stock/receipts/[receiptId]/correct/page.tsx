import { ArrowLeft, PencilLine } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { PageHeader } from "@/components/page-header";
import { receiptNumber } from "@/lib/format";
import { requirePagePermission } from "@/server/auth/request";
import { getCorrectionOptions } from "@/server/business/receipt-corrections";
import { NotFoundError, ValidationError } from "@/server/errors";
import { ReceiveForm } from "../../../receive/receive-form";

export const metadata: Metadata = { title: "Correct a delivery — KuchPos" };

export default async function CorrectReceiptPage({ params }: PageProps<"/stock/receipts/[receiptId]/correct">) {
  const context = await requirePagePermission("stock.receipt.correct");
  const { receiptId } = await params;

  let options: Awaited<ReturnType<typeof getCorrectionOptions>>;
  try {
    options = await getCorrectionOptions(context, { receiptId });
  } catch (error) {
    // A delivery of another business, or a made-up address, looks exactly like one that does not exist.
    if (error instanceof NotFoundError || error instanceof ValidationError) notFound();
    throw error;
  }
  const { receipt, ...receiving } = options;

  return (
    <div className="flex flex-col gap-5">
      <Link
        href={`/stock/receipts/${receipt.id}`}
        className="flex items-center gap-1 text-sm text-muted-foreground underline-offset-4 hover:underline"
      >
        <ArrowLeft className="size-3.5" aria-hidden /> Delivery {receiptNumber(receipt.number)}
      </Link>
      <PageHeader
        icon={PencilLine}
        title={`Correct delivery ${receiptNumber(receipt.number)}`}
        description="Change only what was entered wrongly. The delivery as it is now stays on record, and stock is adjusted by the difference."
      />
      {/* A new version of the delivery gets a fresh form, so nothing is left over from the last one. */}
      <ReceiveForm key={receipt.version} options={receiving} correction={receipt} />
    </div>
  );
}
