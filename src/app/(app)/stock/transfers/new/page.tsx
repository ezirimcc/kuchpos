import { ArrowLeft, ArrowLeftRight } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { PageHeader } from "@/components/page-header";
import { requirePagePermission } from "@/server/auth/request";
import { getTransferOptions } from "@/server/business/transfers";
import { TransferForm } from "./transfer-form";

export const metadata: Metadata = { title: "New transfer — KuchPos" };

export default async function NewTransferPage() {
  const context = await requirePagePermission("stock.transfer");
  const options = await getTransferOptions(context);

  return (
    <div className="flex flex-col gap-5">
      <Link href="/stock/transfers" className="flex items-center gap-1 text-sm text-muted-foreground underline-offset-4 hover:underline">
        <ArrowLeft className="size-3.5" aria-hidden /> Transfers
      </Link>
      <PageHeader
        icon={ArrowLeftRight}
        title="New transfer"
        description="Move stock between the Storeroom and the Shelf. Both places change the moment you save."
      />
      <TransferForm options={options} />
    </div>
  );
}
