import { ShieldCheck } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { PageHeader } from "@/components/page-header";
import { requirePageContext } from "@/server/auth/request";
import { listWaitingApprovals } from "@/server/business/approvals";
import { listWaitingTillCash } from "@/server/business/till";
import { can } from "@/server/permissions";
import { WaitingList } from "./waiting-list";

export const metadata: Metadata = { title: "Waiting for approval — KuchPos" };

export default async function ApprovalsPage() {
  const context = await requirePageContext();
  const sales = can(context, "discount.approve") || can(context, "customer.setCreditLimit") || can(context, "return.approve");
  const tills = can(context, "till.reviewAny") && can(context, "till.operateOwn");
  if (!sales && !tills) redirect("/");
  const [{ requests }, cash] = await Promise.all([
    sales ? listWaitingApprovals(context) : { requests: [] },
    tills ? listWaitingTillCash(context) : { requests: [] },
  ]);

  return (
    <div className="flex max-w-4xl flex-col gap-5">
      <PageHeader
        icon={ShieldCheck}
        title="Waiting for approval"
        description="Discounts, credit over a customer's limit and returns of goods sent by a cashier (these wait 10 minutes), and cash in or cash out asked for at a till. New requests appear here by themselves."
      >
        {can(context, "report.discounts.view") && (
          <Link href="/sales/discounts" className="text-sm text-link underline-offset-4 hover:underline">
            Everything approved so far
          </Link>
        )}
      </PageHeader>
      <WaitingList
        start={requests.map((request) => ({ ...request, requestedAt: request.requestedAt.toISOString(), expiresAt: request.expiresAt.toISOString() }))}
        startCash={cash.requests.map((request) => ({ ...request, requestedAt: request.requestedAt.toISOString() }))}
      />
    </div>
  );
}
