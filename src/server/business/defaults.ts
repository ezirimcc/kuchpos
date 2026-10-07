/** What every new business starts with: a Shelf, a Storeroom, one checkout terminal and "Cash". */
export function defaultLocations(businessId: string) {
  return [
    { businessId, name: "Shelf", kind: "SHELF" as const },
    { businessId, name: "Storeroom", kind: "STOREROOM" as const },
  ];
}

export function defaultTerminal(businessId: string) {
  return { businessId, code: "T1", name: "Checkout 1", paperWidth: "MM80" as const };
}

/** The payment method every business has and cannot switch off. */
export function defaultPaymentMethod(businessId: string) {
  return { businessId, name: "Cash", kind: "CASH" as const, builtIn: true };
}
