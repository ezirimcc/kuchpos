import { ShoppingCart } from "lucide-react";
import type { Metadata } from "next";
import { PageHeader } from "@/components/page-header";
import { requirePagePermission } from "@/server/auth/request";
import { getCheckoutCatalogue } from "@/server/business/sales";
import { Checkout } from "./checkout";

export const metadata: Metadata = { title: "Sell — KuchPos" };

export default async function SellPage() {
  const context = await requirePagePermission("sale.create");
  // The checkout works from this copy of the products and prices, held in the browser,
  // and sends each sale to the server whole (the groundwork for selling during an outage).
  const catalogue = await getCheckoutCatalogue(context);

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        icon={ShoppingCart}
        title="Sell"
        description="Find a product, set the unit and how many, take the cash. F2 jumps to the search box, F4 to the cash box."
      />
      <Checkout catalogue={catalogue} />
    </div>
  );
}
