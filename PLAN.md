# KuchPos — Development Plan

**Status:** Draft 3 (branches removed, owner role added, offline moved before go-live) · **Date:** 2026-10-01 · Read together with [SPEC.md](SPEC.md).

## How we will work

- **One small milestone at a time.** Each one ends with something you can open and try.
- **Each milestone has acceptance checks.** Some are things *you* do on screen ("try to sell more than is in stock; it should refuse"). Others are automated tests the assistant runs and reports honestly — including failures.
- **A checkpoint is saved in version control only after the checks pass** and you are satisfied. If something goes wrong later, we can go back to any checkpoint.
- **Sample data only** until go-live (M18). The sample data always contains **two businesses and one owner**, so that separation between businesses is tested from the first day.
- **"You do"** lists the manual actions needed from you. Where an action involves a password, payment card, or creating an account, you do it yourself; the assistant will give click-by-click instructions.
- If a milestone turns out bigger than expected, it is split rather than rushed.

Legend: 🧑 = you check on screen · 🤖 = automated test

---

## Phase A — Foundations

### M0 · Decisions ✅
- ✅ Batch 1 and Batch 2 questions answered (2026-10-01).
- ✅ Permission table and proposed defaults accepted.
- Remaining questions (SPEC §10, Q14–Q22) are asked when their milestone is reached. None blocks M1–M2; Q19 is needed at M3.

### M1 · Project skeleton ✅ (verified 2026-10-02, tag `m1`)
**Goal:** An empty but working app on your Mac, with the safety rails in place.
- Start version control in this folder; add the ignore-list so secrets and generated files are never saved to it.
- Create the Next.js project (TypeScript, Tailwind, shadcn/ui). *Note: the project generator creates its own `AGENTS.md`/`CLAUDE.md`; these must be merged with the existing `CLAUDE.md`, not overwrite it.*
- Install the local database; connect with Prisma 7.10 (pinned — not the 8 release candidate). *(Done with PostgreSQL at the time; replaced by MariaDB on 2026-10-02.)*
- Add the exact-decimal helpers for Naira/kobo and for quantities, with tests.
- Add test tooling (Vitest, Playwright) with one passing example each.
- Add `.env.example` listing the settings needed, with no real values.

**Accept when:**
- 🧑 You run one command, open `http://localhost:3000`, and see a KuchPos welcome page that says "database connected".
- 🤖 Tests pass; rounding tests cover half-up rounding to the kobo and 3-decimal quantities.
- 🤖 A check confirms no secret file is tracked by version control.

**You do:** Install Postgres.app (guided). Create a free GitHub account if you do not have one, and a private repository (guided).

### M2 · Businesses, owners, sign-in, staff accounts and permissions ✅ (verified 2026-10-02, tag `m2`)
**Goal:** Only known people get in; staff see only their own business; owners can open any business; each role can do only what the table allows.
- **Businesses** exist as records. Owner screens: create / rename / deactivate a business; create its first admin; create and disable other owners; choose which business to open.
- Business admin screen: create staff, set role, disable account, reset password.
- Username + password sign-in (Better Auth), sessions stored in the database, automatic sign-out after inactivity. No public sign-up.
- One central permission list in code that mirrors SPEC §5; every server action checks role **and business**.
- One shared way of reading and writing data that always limits it to the business in use, so that no screen can forget.
- Activity log started (sign-ins, staff changes, owner actions inside a business).
- Settings screen with the first setting: automatic sign-out time per business (C24). "My account" screen where anyone changes their own password (C25).
- Sample data: one owner; two businesses; one staff member per role in each.

**Accept when:**
- 🧑 As owner you create a business and its admin; that admin signs in and creates a cashier.
- 🧑 As owner you open Business A, then Business B; the screen always shows which one is open.
- 🧑 You sign in as each sample role and see a different menu.
- 🧑 Signed in as Business A's admin, you can find no trace of Business B anywhere.
- 🧑 A disabled account cannot sign in, and is signed out if already in. A deactivated business cannot be signed in to.
- 🤖 For **every** row of the permission table, a test calls the server directly as each role and confirms allowed roles succeed and others are refused — without using the screens at all.
- 🤖 For every server action, a test signed in to Business A asks for a Business B record by its ID and is refused.
- 🤖 Only an owner can create a business or an owner; the last owner cannot be disabled.
- 🤖 A signed-out request to any protected action is refused.

**How the 🤖 checks were met (2026-10-02):** 465 automated tests and 26 browser tests pass.
- *Permission table:* every row of SPEC §5 is tested for all five roles against the central permission list (185 checks).
- *Calling the server directly:* every operation that exists so far (staff, settings, activity log, businesses, owners — 19 operations) is called directly as an owner without a business, an owner inside a business, and each of the five roles (133 checks). Rows of the table whose features are not built yet (selling, stock, reports…) get this direct test in the milestone that builds them; a test fails if any new operation is left out.
- *Business separation:* direct tests using Business B's record ids from Business A, plus tests of the shared data layer itself.

### M3 · First online deployment (test site)
**Goal:** The app is reachable on the internet at `pos.kuch99.com` with sample data, so hosting problems are found early, not at the end.

*Changed 2026-10-02: hosted on the owner's existing HOSTAFRICA shared hosting (zero extra cost) with its MariaDB database, instead of Vercel + Neon.*

- Prepare the app to run under the host's Node.js launcher (a small start-up file; a compact production build made on the Mac).
- On the host: a database and database user for the POS; the Node.js application for `pos.kuch99.com`; settings (database address, login secret, site address) entered in the control panel, never in code; HTTPS certificate for the subdomain.
- A repeatable "build on the Mac, upload, apply database changes, restart" procedure, written down as numbered steps.
- Run the database structure and the sample-data seed on the host. Confirm the database-level rules (checks and triggers) were accepted by the host's MariaDB 10.6.
- Sign-in attempt limiting that works on this host. A "TEST — sample data" banner.
- Decide how the test site and the later live site will be kept apart on one hosting account (separate subdomain and separate database).

**Accept when:**
- 🧑 From a different computer — ideally a **Windows** checkout computer in one of the shops — you open `https://pos.kuch99.com`, see the padlock, sign in, and pages feel quick.
- 🧑 The test site clearly shows a "TEST — sample data" banner.
- 🧑 You upload a small visible change yourself by following the written steps (with the assistant guiding).
- 🤖 The health address reports the database connected; the browser tests pass against the online test site.
- 🤖 The database on the host refuses a change to the activity log and an out-of-range setting (the same rules the local tests check).
- 🤖 Memory used by the app on the host stays comfortably under the 1 GB limit after the browser tests.

**You do:** Create the database and the Node.js application in DirectAdmin (guided, click by click; you type the passwords yourself). Pass on HOSTAFRICA's reply about Node.js 22/24.

---

## Phase B — Products and stock

### M4 · Business setup, products, units and prices
**Goal:** The catalogue works, including multi-unit and weighed products.
- Per business: locations (Shelf, Storeroom) and terminals (each with a code and a receipt paper width, 58 mm or 80 mm).
- Business settings: **tax rate (default 0%)** with a history of changes; receipt text. Money in Naira and kobo.
- Products with base unit, extra units and conversions, per-unit selling prices (tax-inclusive), whole-number vs fractional flag, optional barcode, "taxable" tick-box.
- Price history. Units that have been used are retired, not edited.
- Sample catalogue: a single/pack/carton product, a kg/50 kg-bag product, a litre product.

**Accept when:**
- 🧑 You create "single = 1, pack = 10, carton = 100" with three different prices.
- 🧑 You create a kg product with a 50 kg bag.
- 🧑 You change a price and see the old price in the history.
- 🧑 You change the tax rate from 0% and see the change recorded with your name and the time.
- 🧑 A price such as ₦1,250.50 is stored and shown exactly.
- 🧑 A product created in Business A does not appear in Business B.
- 🤖 A cashier cannot change a price or the tax rate by calling the server directly.
- 🤖 Conversions with decimals (e.g. 0.25 kg sachet) convert exactly.

**You do:** Answer Q15 (special customer prices) before this starts.

### M5 · Stock ledger and receiving goods
**Goal:** Stock exists, and every unit of it has a recorded origin.
- Add-only stock movement ledger and per-location balances in base units; the database itself refuses a negative balance.
- Suppliers (simple list). Goods-received document: supplier, location, lines with unit, quantity, cost; optional batch number and expiry date; "expiring soon" list.
- Moving weighted average cost updated on receipt.
- Stock on hand screen: per product, per location, shown in base units and broken into larger units.

**Accept when:**
- 🧑 Receiving 2 cartons (100 each) into Storeroom shows 200 singles there and 0 on Shelf.
- 🧑 Receiving 3 bags of 50 kg shows 150.000 kg.
- 🤖 Submitting the same receipt twice (same ID) creates it once.
- 🤖 The balance always equals the sum of the movements, checked after every test.
- 🤖 If one line of a receipt is invalid, nothing from that receipt is saved.
- 🤖 Receiving 100 at ₦50 then 100 at ₦70 gives an average cost of exactly ₦60.00.

**You do:** Answer Q17 (backdated entries) before this starts.

### M6 · Transfers
**Goal:** Stock moves between Storeroom and Shelf with a paper trail.
- Transfer document with unit selection; out-movement and in-movement saved together.

**Accept when:**
- 🧑 Transferring 1 carton to Shelf gives Storeroom 100, Shelf 100.
- 🧑 Transferring more than is available is refused with a clear message.
- 🤖 Two transfers at the same instant that together exceed stock: exactly one succeeds.
- 🤖 Total stock across locations is unchanged by any transfer.

### M7 · Stock counts and adjustments
**Goal:** Physical reality can be compared with the system and corrected, with reasons.
- Count sheet per location (enter in any unit); difference shown.
- Adjustments with mandatory reason. A storekeeper's adjustment waits for manager approval; a manager's or admin's applies at once.

**Accept when:**
- 🧑 Counting 95 where the system expects 100 proposes an adjustment of −5 and demands a reason.
- 🧑 A storekeeper's adjustment does not change stock until a manager approves it.
- 🤖 An adjustment without a reason is refused by the server.
- 🤖 A sale made between counting and posting is not wiped out by the adjustment.

---

## Phase C — Selling

### M8 · Checkout: cash sale
**Goal:** The core of the system — a correct, fast, safe cash sale.
- Checkout screen: search by name/code/barcode, pick unit and quantity, running total, keyboard-friendly.
- **Built offline-ready from the start:** the screen works from a copy of the product list and prices held in the browser, and sends a complete sale to the server in one message. (The offline queue itself comes in M12.)
- Cash payment with tendered amount and change.
- Sale + lines + stock movements + payment saved in one all-or-nothing step, with snapshots of unit name, conversion, price, tax rate and cost.
- Unique sale ID created on the cashier's computer; receipt number = terminal code + running number.
- Tax worked out from the tax-inclusive price at the business's rate at the moment of sale, for taxable products only, stored on each line (nothing shown while the rate is 0%).
- Printable receipt in both 58 mm and 80 mm layouts, chosen by the terminal's setting.

**Accept when:**
- 🧑 Selling 1 carton + 3 singles reduces Shelf by 103 singles and the receipt shows both lines at their own prices.
- 🧑 Selling 2.5 kg works; selling 2.5 cartons of a whole-number product is refused.
- 🧑 Pressing the Pay button rapidly several times produces one sale.
- 🧑 A receipt at each paper width is readable and nothing is cut off (on a real printer when available; on screen until then).
- 🤖 Two sales of the last unit at the same instant: one succeeds, one is refused, stock ends at exactly 0.
- 🤖 Forcing a failure halfway through saving leaves no sale, no stock change and no payment.
- 🤖 After changing the carton conversion, the price and the tax rate, the old sale still shows its original values.
- 🤖 At 7.5%, a taxable line of ₦1,075.00 records ₦75.00 tax; a non-taxable line records ₦0.00; the customer pays the shelf price either way.
- 🤖 A sale whose price was tampered with in the browser is refused by the server.
- 🤖 A cashier of Business A cannot sell Business B's products or stock.

**You do:** Answer Q14 (receipt contents) before this starts.

### M9 · Other payment methods, split payments, till sessions
**Goal:** Every way a customer pays is recorded correctly.
- Card terminal and bank transfer (recorded, with reference). Split across methods.
- Till sessions: open with float, close with counted cash, show expected vs counted.

**Accept when:**
- 🧑 A sale paid part cash, part transfer shows both on the receipt and in the session summary.
- 🧑 Closing a till shows expected cash = float + cash sales − change − cash refunds.
- 🤖 Payments that do not add up exactly to the total are refused.

### M10 · Customers and credit
**Goal:** Debts are known precisely and can be explained line by line.
- Customer records (per business). Credit as a payment method (full or as part of a split).
- Add-only customer account history; balance = sum of history.
- Repayments by any method, part or full; applied oldest-first unless a sale is chosen.
- Customer statement. Optional credit limit; exceeding it needs manager approval.

**Accept when:**
- 🧑 A sale of ₦10,000 with ₦4,000 cash and ₦6,000 credit raises the customer's balance by ₦6,000.
- 🧑 A later repayment of ₦2,500 leaves ₦3,500 and appears on the statement and in collections.
- 🧑 Credit without a selected customer is refused.
- 🧑 A credit sale over the customer's limit is refused until a manager approves.
- 🤖 Two repayments submitted at the same instant are both recorded once and the balance is correct.
- 🤖 The stored balance always equals the sum of the account history.

**You do:** Answer Q16 (advance deposits) and Q21 (customers with no limit) before this starts.

### M11 · Extra discounts with manager approval
**Goal:** Requirement C11, enforced by the server.
- Discount per line or per sale, with reason. Approval at the cashier's screen (manager credentials) or remotely from the manager's own computer.
- Approval bound to the sale ID and exact discount; single use; expires after 10 minutes.
- Discounts & approvals report.

**Accept when:**
- 🧑 A cashier cannot complete a discounted sale without approval.
- 🧑 After approval, changing the cart or the discount makes the approval invalid.
- 🧑 The report shows cashier, manager, reason, amount, time.
- 🤖 An approval cannot be reused on a second sale, used after expiry, granted by a cashier account, or granted by a manager of another business.
- 🤖 A discounted sale sent straight to the server without a valid approval is refused.

### M12 · Offline checkout  ← moved here because outages are frequent
**Goal:** Requirement C13/C22 — keep selling when the internet drops. Must be finished before any business goes live.
- Confirm the offline rules first (SPEC §8 and Q22).
- The app can be "installed" on the checkout computer and opens without internet.
- Product list, units, prices and last-known stock are kept on the checkout computer and refreshed whenever online.
- Sales made offline go into a queue on the computer and are sent automatically, in order, when the internet returns.
- Always-visible indicator: online / offline / "N sales waiting to send".
- Offline sign-in for a cashier who has signed in on that computer recently.
- Offline exceptions report for managers (e.g. an offline sale that took stock below zero).
- A warning before closing the till if sales are still waiting to send.

**Accept when:**
- 🧑 With Wi-Fi off, the app opens, a cashier completes a cash sale and prints the receipt.
- 🧑 With Wi-Fi off, closing and reopening the browser does not lose the waiting sales.
- 🧑 On reconnect, the waiting sales appear on the server once each, with the same receipt numbers that were printed.
- 🧑 A price changed by a manager while the till was offline is used at the till after it reconnects, and offline sales keep the price the customer was actually charged.
- 🤖 Sending the queue twice, or losing the connection halfway through sending, creates no duplicates and loses no sale.
- 🤖 An offline sale that exceeds server stock is accepted and appears in the exceptions report.
- 🤖 Things not allowed offline (per Q22) are blocked offline with a clear message.
- 🤖 After the offline time limit, the till requires an online sign-in before selling again.
- 🤖 All M8–M11 tests still pass (online behaviour unchanged).

**You do:** Answer Q22. Try it in a shop on the real Windows checkout computer during a real or simulated outage.

### M13 · Voids and returns
**Goal:** Mistakes are corrected openly, never by editing history.
- Return against an original sale line (cannot exceed what was sold); stock back to a location or written off; refund by cash/transfer or off the customer's debt. Manager approval. Void of a whole sale under the same rule. Online only.

**Accept when:**
- 🧑 Returning 1 of 3 packs restores 10 singles and refunds one pack at the price originally paid.
- 🧑 The original sale is unchanged and links to the return.
- 🤖 Returning more than was sold, or returning the same line twice beyond the sold quantity, is refused.

---

## Phase D — Reports and go-live

### M14 · Reports and exports
**Goal:** Requirement C12.
- Per business: sales, collections, stock on hand, stock movement, customer debt (with ageing), discounts & approvals, expiring soon, offline exceptions, activity log. Date and other filters. CSV export.
- Owner overview: every business side by side (sales, collections, outstanding debt).

**Accept when:**
- 🧑 For a sample day, the sales report total equals the sum of that day's receipts; the collections report equals the sum of payments by method.
- 🧑 The accountant account can open and export reports but cannot sell or move stock.
- 🧑 As owner, the overview shows each sample business's figures on its own row, matching that business's own reports.
- 🤖 Report totals are checked against independently calculated totals from the sample data.
- 🤖 Each report is refused for roles not authorised to see it, and never includes another business's records.

**You do:** Answer Q18 (accountant's export format) before this starts.

### M15 · Import from Excel
**Goal:** Requirement C20 — an admin can load existing records instead of typing them.
- Choose the spreadsheet-reading library after checking current documentation.
- Downloadable templates for: products with units and prices; opening stock per location; customers; customers' opening debts.
- Upload → preview with row-by-row problems → confirm. Whole file saved or none of it. Always into the one business that is open.
- Each import recorded (who, when, file, row counts). Opening stock saved as "opening balance" stock movements; opening debts as "opening balance" account entries.

**Accept when:**
- 🧑 You download the product template, fill in ten made-up products including a carton/pack/single product and a kg product, upload it, and they appear correctly.
- 🧑 A file with a deliberate mistake shows the row number and the problem in plain words, and saves nothing.
- 🧑 Imported opening stock appears in the stock movement report as "opening balance"; an imported debt appears on the customer's statement.
- 🧑 The same product file loads into a second business without affecting the first.
- 🤖 Uploading the same file twice into the same business is refused the second time.
- 🤖 A file with one bad row among many saves no rows.
- 🤖 Amounts and quantities typed in Excel (e.g. 1250.5, 2.375) arrive exactly, with no rounding drift.
- 🤖 A non-admin cannot import; an admin of Business A cannot import into Business B.
- 🤖 A file that is too large, of the wrong type, or containing formulas/unexpected content is rejected safely.

**You do:** Answer Q20 — provide a sample of your current Excel layout (made-up or non-sensitive rows).

### M16 · Hardening
**Goal:** Ready to be trusted with real money.
- Review of every server action for permission checks, business separation and input checks; sign-in attempt limiting; session expiry; security review of dependencies.
- Try the whole app on a **Windows** computer in Chrome and Edge, with a real receipt printer at 58 mm and 80 mm.
- Friendly error messages; error monitoring; usability pass with a real cashier trying the sample shop.
- Performance check with a realistically large sample catalogue and sales history, on a slow connection.

**Accept when:**
- 🧑 A staff member who has not seen the app completes a sale, a transfer and a repayment with minimal help.
- 🧑 The same staff member keeps selling through a simulated outage without help.
- 🤖 Full test suite passes. Security checklist completed and recorded.

### M17 · Live environment, backups and restore drill
**Goal:** A separate live system that can survive a mistake or failure.
- Live database and live site at their own address on the hosting account, separate from the test site and its sample data.
- KuchPos's own scheduled backup (a timed job on the host) copied to a second place off the server, in addition to the host's daily backups. **Practise a restore** into a scratch database and verify it.
- Run the full automated test suite against the host's MariaDB 10.6 (the Mac has 10.11).
- Short written runbook: how to restore, how to disable a staff account, what to do in a long outage, who to call.

**Accept when:**
- 🧑 You watch a restore from backup succeed.
- 🧑 The live site is at your domain with a padlock (HTTPS), and shows no sample data.

**You do:** Decide the live address; keep the hosting login somewhere safe (a password manager) and make sure a second trusted person can reach it. Make sure each checkout computer and printer has backup power.

### M18 · Go-live, one business at a time
**Goal:** The shops run on KuchPos.
- **Start with one pilot business.** Add the others one by one only after the pilot is steady. Problems then affect one shop, not five.
- For each business: create it; real staff accounts; products, units and prices imported from Excel; opening stock and opening customer debts imported as opening balances — all traceable.
- Receipt printer set up and tested on the checkout computer; the app installed for offline use and an offline sale tried.
- Run alongside the current method for an agreed period; compare daily totals.

**Accept when (per business):**
- 🧑 Imported stock and debt totals equal the totals in your Excel file.
- 🧑 At the end of each parallel-run day, KuchPos cash, card, transfer and credit totals match your existing records, or every difference is explained.
- 🧑 At the end of each day, "sales waiting to send" is zero.
- 🧑 You declare the old method retired for that business.

---

## Phase E — Later

### M19+ · Candidates
Full per-batch/expiry stock tracking · offline stock receiving and transfers · offering KuchPos to outside businesses (self sign-up, suspension, subscription billing, stricter database-level separation) · customer price lists · supplier purchase orders and supplier debts · barcode label printing · direct receipt-printer/cash-drawer control · payment terminal integration · SMS/WhatsApp debt reminders.

---

## Dependencies at a glance

```
M1 ─ M2 ─ M3 ─ M4 ─ M5 ─ M6 ─ M7
                     └─ M8 ─ M9 ─ M10 ─ M11 ─ M12 ─ M13 ─ M14 ─ M15 ─ M16 ─ M17 ─ M18
```
M6–M7 (transfers, counts) and M8–M11 (selling) both depend on M5 and can be done in either order.
M15 (Excel import) can be brought forward to any point after M10 if you want to try the app with your own product list sooner — on the test site, with non-sensitive data only.

## What could change this plan

- **Q22 (what must work offline):** allowing credit sales or discounts offline makes M12 noticeably larger and weakens some checks during outages.
- **Q15 (special customer prices):** a "yes" adds price lists to M4 and M8.
- **More than one checkout computer in a business:** already allowed for by the design (terminals, simultaneous-sale protection); needs only extra testing.
- **Offering KuchPos to outside businesses:** a separate later project (M19+).
- **Shared hosting proving too small or too slow:** move to a small private server (VPS) with the same code; this would add a monthly cost.
- **HOSTAFRICA adding Node.js 22/24:** switch the app to it at once (small task).
