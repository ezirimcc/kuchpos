/**
 * The import workbook (C66): one Excel file per shop with five sheets. This is the single
 * description of it — the blank template people download is written from it
 * (`scripts/make-import-template.ts`), and the import reads sheets and columns by these
 * names. Change a heading here and both follow.
 *
 * Safe for both sides (plain data, no server-only code).
 */

export type ImportColumn = {
  /** The heading in row 1, exactly as the import looks for it (compared without regard to capitals or spaces). */
  heading: string;
  required: boolean;
  /** Shown in row 2 of the template, in grey, to say what goes in the column. */
  hint: string;
  /** An example for row 3 of the template. */
  example: string;
  width: number;
};

export type ImportSheet = { name: string; purpose: string; columns: Record<string, ImportColumn> };

const column = (heading: string, required: boolean, hint: string, example: string, width = 18): ImportColumn => ({ heading, required, hint, example, width });

export const PRODUCTS_SHEET = {
  name: "Products",
  purpose: "One row for each unit a product is sold or bought in. A product with three units is three rows with the same code and name.",
  columns: {
    code: column("Product code", true, "Your own short code. It ties the other sheets to this one.", "TOM-001"),
    name: column("Product name", true, "", "Tomato Seed Sachet", 30),
    category: column("Category", false, "Created if it does not exist yet.", "Seeds"),
    barcode: column("Barcode", false, "", ""),
    fractions: column("Sold in fractions?", false, "Yes only for things weighed or measured (kg, litres). Empty means No.", "No", 20),
    taxable: column("Taxable?", false, "Empty means Yes.", "Yes", 12),
    batch: column("Has batch number?", false, "Empty means No.", "No"),
    expiry: column("Has expiry date?", false, "Empty means No.", "Yes"),
    unit: column("Unit name", true, "", "sachet"),
    contains: column("Contains how many of the smallest unit", true, "1 for the smallest unit; for example 100 for a carton of 100.", "1", 36),
    price: column("Selling price", false, "In Naira, no commas. Empty if the product is not sold in this unit.", "500"),
    bought: column("Bought in this unit?", false, "Empty means Yes.", "Yes", 20),
  },
} as const satisfies ImportSheet;

export const CUSTOMERS_SHEET = {
  name: "Customers",
  purpose: "One row for each customer.",
  columns: {
    name: column("Name", true, "", "Chief Okoro", 28),
    phone: column("Phone", true, "Must be different for every customer.", "08031112222"),
    address: column("Address", false, "", "12 Market Road", 28),
    city: column("City", false, "", "Aba"),
    state: column("State", false, "", "Abia"),
    creditLimit: column("Credit limit", false, "In Naira. Empty means this customer cannot buy on credit.", "50000"),
    owed: column("Owed on the starting day", false, "In Naira. Empty means nothing was owed.", "12500", 26),
  },
} as const satisfies ImportSheet;

export const STOCK_SHEET = {
  name: "Stock",
  purpose: "What was counted on the starting day. A product counted as 4 cartons and 7 sachets is two rows. Everything goes onto the Shelf.",
  columns: {
    code: column("Product code", true, "As on the Products sheet.", "TOM-001"),
    unit: column("Unit", true, "One of that product's units.", "carton"),
    quantity: column("Quantity counted", true, "", "4"),
    cost: column("Cost per unit", true, "In Naira: what one of this unit cost the shop.", "38000"),
    batch: column("Batch", false, "Only for products that have batch numbers.", ""),
    expiry: column("Expiry date", false, "Only for products that have expiry dates. Day/month/year.", "31/03/2027"),
  },
} as const satisfies ImportSheet;

export const DELIVERIES_SHEET = {
  name: "Deliveries",
  purpose: "Goods received since the starting day: one row per product received. Rows with the same delivery reference are one delivery.",
  columns: {
    date: column("Delivery date", true, "Day/month/year.", "03/10/2026"),
    reference: column("Delivery reference", true, "Your own number for the delivery.", "D-014", 20),
    supplier: column("Supplier", true, "Created if it does not exist yet.", "Agro Supplies Ltd", 26),
    code: column("Product code", true, "As on the Products sheet.", "TOM-001"),
    unit: column("Unit", true, "", "carton"),
    quantity: column("Quantity", true, "", "2"),
    cost: column("Cost per unit", true, "In Naira.", "38000"),
    batch: column("Batch", false, "", ""),
    expiry: column("Expiry date", false, "Day/month/year.", ""),
    note: column("Note", false, "", "", 26),
  },
} as const satisfies ImportSheet;

export const SALES_SHEET = {
  name: "Sales",
  purpose: "Sales made since the starting day: one row per product sold. Rows with the same receipt number are one sale.",
  columns: {
    date: column("Date", true, "Day/month/year.", "02/10/2026"),
    time: column("Time", false, "Hour:minute, 24-hour clock. Helps the report by hour.", "14:35", 12),
    receipt: column("Receipt number", true, "Your own receipt or reference number.", "0457"),
    code: column("Product code", true, "As on the Products sheet.", "TOM-001"),
    unit: column("Unit", true, "", "sachet"),
    quantity: column("Quantity", true, "", "3"),
    price: column("Price per unit", true, "In Naira: what one of this unit was sold for.", "500"),
    discount: column("Discount on the whole sale", false, "In Naira. Fill it on the first row of the sale only.", "", 26),
    paidBy: column("Paid by", true, "Cash, or the name of one of the shop's other payment methods.", "Cash"),
    customerPhone: column("Customer phone", false, "Must be on the Customers sheet.", ""),
    onCredit: column("Amount on credit", false, "In Naira. Needs the customer. Fill it on the first row of the sale only.", "", 20),
    soldBy: column("Sold by", false, "A name, kept as a note.", ""),
  },
} as const satisfies ImportSheet;

export const IMPORT_SHEETS = [PRODUCTS_SHEET, CUSTOMERS_SHEET, STOCK_SHEET, DELIVERIES_SHEET, SALES_SHEET] as const;

/** Where the blank workbook is served from (written by `scripts/make-import-template.ts`). */
export const IMPORT_TEMPLATE_PATH = "/templates/kuchpos-import-template.xlsx";
/**
 * Row 1 holds the headings, row 2 the grey notes, row 3 an example. None of those is ever
 * imported: the shop's own rows start in row 4.
 */
export const IMPORT_FIRST_DATA_ROW = 4;

/** The first sheet of the template: how to fill it in. */
export const IMPORT_INSTRUCTIONS = [
  "KuchPos import workbook — one file for one shop.",
  "",
  "1. Fill in the sheets Products, Customers, Stock, Deliveries and Sales. Leave a sheet empty if you have nothing for it.",
  "2. Do not change the headings in row 1. Columns marked with a star (*) must be filled in on every row.",
  "3. Rows 1 to 3 of each sheet (headings, notes, example) are never imported. Type your own rows from row 4 down.",
  "4. Amounts are in Naira, as plain numbers: 1250 or 1250.50. No commas, no ₦ sign.",
  "5. Dates are day/month/year, for example 03/10/2026.",
  "6. Product codes tie the sheets together: a code used on Stock, Deliveries or Sales must be on the Products sheet.",
  "7. In KuchPos, sign in as the admin, open Settings, then Import from Excel, and choose this file. You are shown what will be brought in, and every row that has a problem, before anything is saved.",
  "8. Products, Customers and Stock are brought in first. Deliveries and Sales are brought in afterwards, in a second step.",
  "9. A product or customer that is already in KuchPos is left as it is, so the same file can be used again after adding more rows. Stock rows are different: once a product's starting stock is in, delete its row from the Stock sheet before using the file again.",
] as const;
/** The largest workbook the import accepts, and the most rows it reads from one sheet. */
export const IMPORT_MAX_BYTES = 5 * 1024 * 1024;
export const IMPORT_MAX_ROWS = 20_000;
