/** The kinds a payment method can be (SPEC C46). CASH is what ends up in the till drawer. */
export const PAYMENT_KINDS = [
  { value: "CASH", label: "Cash" },
  { value: "TRANSFER", label: "Bank transfer" },
  { value: "POS", label: "POS / card machine" },
] as const;

export type PaymentKindValue = (typeof PAYMENT_KINDS)[number]["value"];

export const PAYMENT_KIND_VALUES = PAYMENT_KINDS.map((kind) => kind.value) as [PaymentKindValue, ...PaymentKindValue[]];

export function paymentKindLabel(value: string): string {
  return PAYMENT_KINDS.find((kind) => kind.value === value)?.label ?? value;
}
