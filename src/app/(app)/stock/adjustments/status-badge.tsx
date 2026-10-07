import { Badge } from "@/components/ui/badge";
import { ADJUSTMENT_STATUS_LABELS, type AdjustmentStatus } from "@/lib/adjustment-reasons";

const VARIANT = { PENDING: "default", APPLIED: "success", REJECTED: "destructive" } as const;

export function StatusBadge({ status }: { status: AdjustmentStatus }) {
  return (
    <Badge variant={VARIANT[status]} data-testid="adjustment-status">
      {ADJUSTMENT_STATUS_LABELS[status]}
    </Badge>
  );
}
