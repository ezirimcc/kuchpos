/** What each kind of stock movement is called on screen. */
export const MOVEMENT_LABELS: Record<string, string> = {
  OPENING_BALANCE: "Opening stock (brought in)",
  SHORTFALL_COVERED: "Covered a sale beyond stock",
  RECEIPT: "Delivery received",
  RECEIPT_CORRECTION: "Delivery corrected",
  TRANSFER_OUT: "Moved out",
  TRANSFER_IN: "Moved in",
  ADJUSTMENT: "Adjustment",
  SALE: "Sold",
  SALE_CANCELLATION: "Sale cancelled",
  SALE_RETURN: "Returned by customer",
};
