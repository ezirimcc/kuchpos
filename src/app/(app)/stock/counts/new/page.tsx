import { ArrowLeft, ClipboardCheck } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { PageHeader } from "@/components/page-header";
import { requirePagePermission } from "@/server/auth/request";
import { getCountSheet } from "@/server/business/counts";
import { CountForm } from "./count-form";

export const metadata: Metadata = { title: "New stock count — KuchPos" };

export default async function NewCountPage() {
  const context = await requirePagePermission("stock.count");
  const sheet = await getCountSheet(context);

  return (
    <div className="flex flex-col gap-5">
      <Link href="/stock/counts" className="flex items-center gap-1 text-sm text-muted-foreground underline-offset-4 hover:underline">
        <ArrowLeft className="size-3.5" aria-hidden /> Stock counts
      </Link>
      <PageHeader
        icon={ClipboardCheck}
        title="New stock count"
        description="Enter what you actually count. What the system expects is shown only after you save, and saving a count changes no stock."
      />
      <CountForm sheet={sheet} />
    </div>
  );
}
