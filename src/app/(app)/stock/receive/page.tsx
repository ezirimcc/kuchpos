import { PackagePlus } from "lucide-react";
import type { Metadata } from "next";
import { PageHeader } from "@/components/page-header";
import { requirePagePermission } from "@/server/auth/request";
import { getReceivingOptions } from "@/server/business/stock";
import { StockTabs } from "../stock-tabs";
import { ReceiveForm } from "./receive-form";

export const metadata: Metadata = { title: "Receive goods — KuchPos" };

export default async function ReceivePage() {
  const context = await requirePagePermission("stock.receive");
  const options = await getReceivingOptions(context);

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        icon={PackagePlus}
        title="Receive goods"
        description="Record a delivery from a supplier. Stock goes up the moment you save. A mistake found later can be corrected by a manager or admin, and the original stays on record."
      />
      <StockTabs context={context} current="receive" />
      <ReceiveForm options={options} />
    </div>
  );
}
