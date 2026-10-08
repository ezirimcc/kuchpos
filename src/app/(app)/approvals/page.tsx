import { ShieldCheck } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { PageHeader } from "@/components/page-header";
import { requirePageContext } from "@/server/auth/request";
import { listWaitingApprovals } from "@/server/business/approvals";
import { can } from "@/server/permissions";
import { WaitingList } from "./waiting-list";

export const metadata: Metadata = { title: "Waiting for approval — KuchPos" };

export default async function ApprovalsPage() {
  const context = await requirePageContext();
  if (!can(context, "discount.approve") && !can(context, "customer.setCreditLimit")) redirect("/");
  const { requests } = await listWaitingApprovals(context);

  return (
    <div className="flex max-w-4xl flex-col gap-5">
      <PageHeader
        icon={ShieldCheck}
        title="Waiting for approval"
        description="Discounts, and credit over a customer's limit, that a cashier has sent to be approved. New requests appear here by themselves. A request waits 10 minutes."
      >
        {can(context, "report.discounts.view") && (
          <Link href="/sales/discounts" className="text-sm text-link underline-offset-4 hover:underline">
            Everything approved so far
          </Link>
        )}
      </PageHeader>
      <WaitingList
        start={requests.map((request) => ({ ...request, requestedAt: request.requestedAt.toISOString(), expiresAt: request.expiresAt.toISOString() }))}
      />
    </div>
  );
}
