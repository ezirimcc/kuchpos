import { ArrowLeft, Scale } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { PageHeader } from "@/components/page-header";
import { requirePagePermission } from "@/server/auth/request";
import { getAdjustmentOptions } from "@/server/business/adjustments";
import { AdjustmentForm } from "./adjustment-form";

export const metadata: Metadata = { title: "New stock adjustment — KuchPos" };

export default async function NewAdjustmentPage() {
  const context = await requirePagePermission("stock.adjust.request");
  const options = await getAdjustmentOptions(context);

  return (
    <div className="flex flex-col gap-5">
      <Link href="/stock/adjustments" className="flex items-center gap-1 text-sm text-muted-foreground underline-offset-4 hover:underline">
        <ArrowLeft className="size-3.5" aria-hidden /> Stock adjustments
      </Link>
      <PageHeader
        icon={Scale}
        title="New stock adjustment"
        description={
          options.appliesAtOnce
            ? "Add stock to, or take stock out of, one location, with a reason. Stock changes the moment you save."
            : "Add stock to, or take stock out of, one location, with a reason. A manager or admin must approve it before stock changes."
        }
      />
      <AdjustmentForm options={options} />
    </div>
  );
}
