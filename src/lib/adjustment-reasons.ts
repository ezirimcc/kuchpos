/** Why stock was adjusted (SPEC C40). The order here is the order shown in lists. */
export const ADJUSTMENT_REASONS = [
  { value: "DAMAGED", label: "Damaged" },
  { value: "EXPIRED", label: "Expired" },
  { value: "MISSING", label: "Missing or stolen" },
  { value: "COUNT_ERROR", label: "Counting error" },
  { value: "FOUND", label: "Found" },
  { value: "SAMPLE_GIFT", label: "Sample or gift" },
  { value: "DATA_ENTRY_ERROR", label: "Data entry error" },
  { value: "OTHER", label: "Other (explain in the note)" },
] as const;

export type AdjustmentReasonValue = (typeof ADJUSTMENT_REASONS)[number]["value"];

export const ADJUSTMENT_REASON_VALUES = ADJUSTMENT_REASONS.map((reason) => reason.value) as [
  AdjustmentReasonValue,
  ...AdjustmentReasonValue[],
];

export function reasonLabel(value: string): string {
  if (value === "OTHER") return "Other";
  return ADJUSTMENT_REASONS.find((reason) => reason.value === value)?.label ?? value;
}

/** Whether an adjustment is waiting for a decision, has changed stock, or was turned down. */
export type AdjustmentStatus = "PENDING" | "APPLIED" | "REJECTED";

export const ADJUSTMENT_STATUS_LABELS: Record<AdjustmentStatus, string> = {
  PENDING: "Waiting for approval",
  APPLIED: "Applied",
  REJECTED: "Rejected",
};
