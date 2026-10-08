import { ArrowLeft, UserPlus } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { PageHeader } from "@/components/page-header";
import { requirePagePermission } from "@/server/auth/request";
import { NewCustomerForm } from "./new-customer-form";

export const metadata: Metadata = { title: "New customer — KuchPos" };

export default async function NewCustomerPage() {
  await requirePagePermission("customer.manage");
  return (
    <div className="flex max-w-3xl flex-col gap-5">
      <Link href="/customers" className="flex items-center gap-1 text-sm text-muted-foreground underline-offset-4 hover:underline">
        <ArrowLeft className="size-3.5" aria-hidden /> Customers
      </Link>
      <PageHeader
        icon={UserPlus}
        title="New customer"
        description="A new customer can pay like anyone else. To let them buy on credit, a manager or admin sets a credit limit afterwards."
      />
      <NewCustomerForm />
    </div>
  );
}
