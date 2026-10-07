# KuchPos — Project Rules for Development Sessions

KuchPos is a POS and inventory web application for agricultural products shops in Nigeria. It is **multi-business**: each shop is an independent business, fully separate from the others (5 today, up to ~20). There is **no branch level**. **Owners** sit above the businesses.
Read [SPEC.md](SPEC.md) (what to build) and [PLAN.md](PLAN.md) (in what order) before doing any work.

Next.js's own rules for coding agents are in AGENTS.md (kept up to date by `next dev`) and are part of these instructions:

@AGENTS.md

## Current status

- **M1 (project skeleton) is done** — verified by the owner on 2026-10-02, tagged `m1`.
- **M2 (businesses, owners, sign-in, staff, permissions, automatic sign-out setting, change own password) is done** — verified by the owner on 2026-10-02, tagged `m2`.
- **Database switched from PostgreSQL to MariaDB on 2026-10-02** (owner's decision, for zero-cost hosting). All tests pass on MariaDB; committed after `m2`.
- **M3 (first online deployment / test site) is done** — verified by the owner on 2026-10-02, tagged `m3`. Test site: https://pos.kuch99.com (HOSTAFRICA shared hosting, Node.js 24.21.0, MariaDB 10.6.24, sample data, yellow TEST banner). Confirmed on the host: database rules enforced, UTC clock, real visitor address, HTTPS redirect and security headers, sign-in limit of 10 per minute, all 26 browser tests, quick pages from a Windows checkout computer, certificate renews automatically.
- The keep-awake cron job on the host was created by the owner (confirmed 2026-10-03).
- **M4 (business setup, products, units, prices; plus categories, paging, filters, live search, the new look, dashboard, profile) is done** — verified by the owner on 2026-10-03, tagged `m4`. The test site was confirmed on version `m3-4` (all database rules enforced). Profile editing (own full name and username) was added after that upload, which went up with the M5 bundle.
- **M5 (stock ledger and receiving goods, plus correcting a saved delivery — C39, added 2026-10-06) is done** — tried by the owner ("Everything works fine") and uploaded to the test site as version `m4-2` on 2026-10-07, tagged `m5`. 
- **M6 (transfers between Storeroom and Shelf) is done** — tried by the owner ("This is good") and uploaded to the test site as version `m5-1` on 2026-10-07, tagged `m6`. 
- **M7 (stock counts and adjustments, with approval of a storekeeper's adjustments) is done** — tried by the owner on this computer and uploaded to the test site as version `m6-1` (System check: all rules enforced) on 2026-10-07, tagged `m7`. Owner's decisions for M7 (2026-10-07): fixed reason list plus note (C40); blind counts (C41); counts may cover part of a location (C42); delivery corrections need no second approval (C43). Q14 is answered (C44 receipt contents, C45 what happens after a sale).
- **M8 (checkout: cash sale, receipts, sales list) is built and all checks pass; waiting for the owner to try it (including a real receipt printer if one is at hand) and for the upload to the test site**, then tag `m8`. Next after that: M9 (card and transfer payments, split payments, till sessions). Owner's decisions for M5 (2026-10-03): admins and managers may backdate a delivery with a note, logged (C35); storekeeper, manager, admin see cost prices on deliveries (C36); batch number and expiry date are per-product settings (C37); "expiring soon" months is an admin setting, default 3 (C38).
- Lesson: DirectAdmin puts a placeholder `index.html` in a new subdomain's web folder (`domains/kuch99.com/public_html/pos/`); it must be deleted or the front address shows it instead of the app. Never delete the `.htaccess` there.
- Remaining open questions (SPEC §10, Q14–Q22) are each tied to a milestone. Ask them when that milestone is next, not before.
- Update this section at the end of every milestone: which milestone is done, which is next.

## Working with the owner

- The owner is a **programming novice** and the shop's decision-maker. Explain in plain language; define any technical term the first time it is used.
- When a manual action is needed, give **exact, numbered, click-by-click steps**, say what they should see afterwards, and wait for confirmation.
- The owner personally does anything involving account creation, passwords, payment cards, or accepting terms. Never ask them to paste a password or secret key into the chat.
- Ask **no more than five questions at a time**. Offer a recommended answer with each.
- The owner accepted the permission table and all proposed defaults on 2026-10-01, so items labelled "Proposed" in SPEC.md as of that date are confirmed. Anything listed as **open** in SPEC §10, and any **new** proposal made after that date, is **not decided**: do not build it as if confirmed. When the owner decides, update SPEC.md first, then build.
- Report results honestly: if a test fails or a step was skipped, say so plainly.

## Scope discipline

- Work on **one milestone at a time**, in PLAN.md order unless the owner changes it. Do not start the next milestone until the current one's acceptance checks pass and the owner agrees.
- Do not add features, libraries or services that are not in SPEC.md without asking.
- If a milestone is larger than expected, propose splitting it.

## Technology (versions checked 2026-10-01)

| Part | Choice |
|---|---|
| Runtime | Node.js 24 LTS on both the development Mac and the hosting server (HOSTAFRICA added 24.21.0 on 2026-10-02; before that only 20.19.4 was offered, and the app was verified on it) |
| App framework (interface + server) | Next.js 16.3 (App Router, TypeScript, Turbopack), React 19 |
| Styling / components | Tailwind CSS 4, shadcn/ui |
| Database | **MariaDB**. Hosting server: 10.6.24. Development Mac: 10.11.6 (DBngin). Use only features that exist in 10.6 |
| Database toolkit | Prisma ORM **7.10.x**, provider `mysql`, with `@prisma/adapter-mariadb` |
| Login | Better Auth 1.7 (username plugin only), sessions in our database. Accounts are managed by our own code — see "Login notes" |
| Validation | Zod 4 |
| Exact arithmetic | decimal.js 10 |
| Tests | Vitest 5, Playwright |
| Offline (M12) | Dexie 4 (IndexedDB), Serwist 9 (service worker) |
| Hosting | The owner's existing **HOSTAFRICA shared web hosting** (DirectAdmin, CloudLinux; 1 GB memory, 75% of one core, 20 entry processes) at `pos.kuch99.com`. App and database on the same server. Zero extra budget |
| Package manager | npm |

Version rules:

- **Pin Prisma to 7.x.** On npm the `latest` tag currently points at an 8.0 release candidate, so `npm install prisma` alone installs the wrong thing. Always install `prisma@7` and `@prisma/client@7`. Better Auth 1.7 supports Prisma 5–7 only. Revisit only when Prisma 8 is stable *and* Better Auth supports it.
- Before adding or upgrading any dependency, check its current official documentation and `npm view <package> dist-tags`. Do not rely on memory for APIs — these tools change quickly. Next.js ships its docs inside `node_modules/next/dist/docs/`; prefer those for the installed version.
- Use stable releases only. No release candidates, betas or "experimental" flags in anything that touches money or stock.
- Use no hosting-specific features that would prevent running the app as a plain Node.js server elsewhere.
- When scaffolding at M1, `create-next-app` generates its own `AGENTS.md` and a `CLAUDE.md`. **Merge** them into this file; never let them overwrite it. (Scaffold in a temporary folder and move files in.)

## Confirmed facts that shape the code

- **Currency:** Nigerian Naira with kobo. Money is `DECIMAL(14,2)`; display as `₦1,250.00`. No cash rounding beyond the kobo.
- **Tax:** a per-business setting, default **0%**, changeable by the admin, with a change history. Each sale line snapshots its tax rate and amount. Prices are **tax-inclusive**; each product has a `taxable` flag. Line tax = line total × rate ÷ (100 + rate), rounded half-up to the kobo, for taxable products only; the customer always pays the shelf price.
- **Structure:** Platform → Business → Locations (Shelf, Storeroom) and Terminals. **No branch level — do not add one.** Products, prices, stock, customers, debts, staff, settings and reports all belong to exactly one business. Nothing is shared or moved between businesses.
- **Roles:** five business roles (admin, manager, accountant, cashier, storekeeper), each account tied to exactly one business; plus **owner**, which is not tied to a business. Owners (there can be several) create/deactivate businesses, create other owners, can open any business with full admin rights, and see an all-businesses overview. The last owner cannot be disabled.
- **Outages are frequent**, so offline checkout (M12) is required before go-live. One checkout computer per business today; design for more.
- **Time zone:** Africa/Lagos for display and for "business day" boundaries.
- **Clients:** Windows checkout computers, Chrome/Edge. Receipts via browser print at **58 mm or 80 mm** (per-terminal setting). Barcode is an optional product field; a scanner is just keyboard input.
- **Excel import** by business admins and owners, always into one business (SPEC §4.8, PLAN M15).
- **Automatic sign-out** is a per-business setting (`business.idleSignOutMinutes`, 5–480, default 30) changed by the admin on the Settings screen. Owners are fixed at 30 minutes. Enforced on every request in `src/server/auth/context.ts` using `session.lastActiveAt`; the login library's own session lifetime is only the 8-hour upper bound.
- **Everyone can change their own password** (`/account`, `src/server/auth/account.ts`): current password required; other sessions of that person are signed out.

## Engineering rules (non-negotiable)

### 0. Businesses are sealed off from each other
- Every business-owned table has a `businessId`. Uniqueness rules (product codes, receipt numbers, customer codes, terminal codes) are scoped to the business, not global. Usernames are the one exception: unique across the whole system.
- For staff, the business comes **only from the signed-in session**, never from anything the browser sends. For an owner, the "business currently open" is chosen by the owner, stored server-side with the session, and re-checked on every request (the business must exist; the user must still be an active owner).
- Owner actions inside a business are written to that business's activity log under the owner's own name. Owner-only actions (create business, create owner, overview) are checked as owner-only on the server.
- All data access goes through one scoped data-access layer that applies the business filter. Screens and actions never query the database client directly. The owner overview is the only cross-business read; it lives in its own clearly named module and returns per-business figures, never mixed rows.
- A record fetched by ID must also match the session's business; a mismatch is reported as "not found".
- Every server action has a cross-business test (PLAN M2). The seed always contains one owner and two businesses.
- If KuchPos is ever offered to outside businesses, add a second, database-level layer of separation first (MariaDB has no row-level security, so this would mean a separate database or database user per business).

### 1. Permissions are enforced on the server
- Every server action and route handler starts by identifying the signed-in user and checking a named permission from **one central permission map** (mirrors SPEC §5), **together with business scope**. No exceptions.
- Hiding or disabling a button is a convenience, never the protection.
- Never trust anything sent by the browser: role, user ID, price, total, discount, cost, approval status are all re-derived or re-checked on the server.
- Every permission has a test that calls the server directly as each role.

### 2. Traceable history for stock and money
- `stock movements`, `payments`, `customer account entries`, `approvals` and the `activity log` are **append-only**. No UPDATE or DELETE on them in application code.
- Corrections are new, opposite records linked to the original (void, return, reversing adjustment).
- Every such record stores who, when (server time), what document it belongs to, and — for adjustments, discounts, voids and returns — a reason.
- Stored balances (stock per location, customer balance) are conveniences; they must always equal the sum of their history. Tests assert this.
- Master records that have been used (products, units, customers, staff) are deactivated, never deleted.

### 3. All-or-nothing saving
- A sale, its lines, its stock movements, its payments, any customer account entry and the consumption of any approval are written in **one database transaction**. The same applies to goods received, transfers, adjustments, repayments and returns.
- No network calls or slow work inside a transaction.
- Tests force a failure mid-transaction and assert that nothing was saved.

### 4. No duplicates; safe with simultaneous users
- Every state-changing submission carries a **client-generated unique ID** (UUID) stored under a database unique constraint. A repeat with the same ID returns the original result and changes nothing.
- Stock is reduced with a single conditional update ("subtract only if enough remains") and the database has a `CHECK (quantity >= 0)` on balances. Never read-then-write stock in application code.
- When one transaction touches several balance rows, lock/update them in a consistent order (by product ID, then location ID) to avoid deadlocks. Retry a bounded number of times on deadlock/serialization errors.
- Receipt numbers are `terminal code + per-terminal sequence`, never "highest number + 1".
- Buttons disable while submitting, but this is not the protection — the unique ID is.
- Concurrency tests (two sellers, last unit; two repayments, same customer) are required for M6, M8 and M10, and duplicate/partial-sync tests for M12.

### 5. Exact arithmetic
- **Never use JavaScript `number` for money or quantities.** No `parseFloat`, `Number()`, `toFixed`, `+`, `*` on such values.
- Database: `DECIMAL` columns with explicit precision — money to 2 decimal places (kobo), quantities and conversion factors to 3 decimal places. Never Prisma's default `Decimal(65,30)`; always specify `@db.Decimal(p, s)`.
- Code: `decimal.js` through a small shared money/quantity module. All rounding happens there, in one place: half-up, per sale line; the sale total is the sum of rounded lines.
- Values cross the network as strings, not numbers.
- Store every computed amount (line total, discount, tax, sale total, change). Never recompute a historical total from current settings.

### 6. Preserve history when settings change
- Every transaction line stores a **snapshot**: unit name, conversion factor, unit price, (tax rate), (unit cost), plus the base-unit quantity.
- A unit that appears in any transaction is retired and replaced, not edited. A product's base unit cannot change once it has stock history.
- Price changes write a price-history record.
- Reports read snapshots, not current product settings.

### 7. Sample data during development
- Development and the test site use **invented sample data** from a seed script (one user per role, multi-unit and weighed products, customers with debts).
- Never copy the live database to a development machine or the test site. Never put real customer names or debts in tests, seeds or screenshots.
- The test site shows a visible "TEST — sample data" banner.

### 8. Secrets stay out of source control
- Secrets live only in `.env` files (git-ignored) locally and in the hosting dashboard online. `.env.example` lists names with no real values.
- `.gitignore` must exist **before the first commit** and cover `.env*` (except `.env.example`), `node_modules`, build output.
- Before every commit, check staged files for secrets. If a secret is ever committed, tell the owner immediately; it must be rotated, not just removed.
- Never print secrets in the chat, logs, or error messages. Seed passwords for sample users go in the seed/example config, not in chat.

### 9. Checkpoint after each verified milestone
- When a milestone's acceptance checks pass and the owner agrees: commit with a message naming the milestone (e.g. `M5: stock ledger and goods received`), tag it (`m5`), and push to GitHub.
- Small commits within a milestone are fine; the tag marks the verified state.
- Never rewrite history that has been pushed. Never commit with failing tests without saying so.
- Update the "Current status" section above and tick the milestone in PLAN.md in the same commit.

### Additional rules
- **Database changes** only through Prisma migrations committed to the repository. Never edit an applied migration; never change the live database by hand. Migrations on live data must not lose data — back up first.
- **Excel import (M15):** treat uploaded files as untrusted — limit size and type, read cell values as text and parse them through the money/quantity module (never as JavaScript numbers), never evaluate formulas, validate every row with Zod, save the whole file in one transaction or not at all, record the import, and reject a repeat of the same file. Opening stock and opening debts go in as ordinary ledger entries of type "opening balance". Choose the reading library at M15 after checking current docs; as of 2026-10-01 the npm packages `xlsx` (0.18.5) and `exceljs` (4.4.0) have had no recent npm releases, while `read-excel-file` is actively maintained.
- **Time:** store UTC; record server time on every record (plus device time for offline sales); display and group by the shop's time zone.
- **Offline-readiness from day one** (SPEC §8): client-generated sale IDs, terminal-based receipt numbers, the sale-posting function accepts and validates the prices the cashier saw, and the checkout screen (M8) works from a browser-held copy of the catalogue and submits a whole sale in one message. Offline itself is built at M12 — after M8–M11 are verified online, before go-live. Offline sync must call the same `postSale` module as online checkout, never a second copy of the rules. What is allowed offline is open (Q22).
- **Validation:** every server input is checked with a Zod schema. Reject, do not silently fix.
- **Business rules live in server-side modules** (e.g. `postSale`, `postTransfer`) that screens call — not inside screen components — so they can be tested directly and reused by offline sync.
- **Errors shown to staff** are plain sentences that say what to do next. Technical details go to the log.
- **Interface:** designed for computer screens; checkout must be fully usable from the keyboard; simple words on screen; no jargon.

## Testing expectations

- Every acceptance check marked 🤖 in PLAN.md becomes an automated test.
- Stock, money, permission and approval logic are tested against a **real MariaDB database**, not a fake, because the guarantees depend on the database.
- Run the full test suite before proposing a checkpoint. Show the owner the summary.

## Commands

| What | Command |
|---|---|
| Start the app on this computer (then open http://localhost:3000) | `npm run dev` |
| Run lint + type check + unit tests | `npm run check` |
| Run unit tests only | `npm run test` |
| Run browser tests (uses installed Google Chrome) | `npm run test:e2e` |
| Apply database structure changes (creates a migration) | `npm run db:migrate` |
| Regenerate the database client after a schema change | `npm run db:generate` |
| Wipe the development database and load fresh sample data | `npm run db:seed` |
| Build the zip file to upload to the hosting server (`deploy/kuchpos-deploy.zip`) | `npm run deploy:build` |
| Run only the fast tests / only the database tests | `npm run test:unit` / `npm run test:db` |

- `npm run test` runs both the fast tests and the database tests (the latter against `kuchpos_test`, never the development database).
- `npm run test:e2e` **re-seeds the development database first**, so anything created by hand in sample data is wiped.
- After changing `prisma/schema.prisma`: run `npm run db:migrate`, then `npm run db:generate`, then **restart `npm run dev`** (the running server keeps the old database client in memory and fails with "Prisma schema mismatch").
- Sample users: `owner`, and `gv.` / `sf.` + `admin`, `manager`, `accountant`, `cashier`, `storekeeper` (e.g. `gv.cashier`). Their shared password is `SEED_PASSWORD` in `.env`.

## Project layout and local setup notes

- `src/app/` screens and thin `"use server"` actions · `src/server/` everything that runs only on the server · `src/lib/` small helpers safe for both sides · `src/components/` screen components · `prisma/` database schema, migrations and seed · `tests/unit/` (no database), `tests/db/` (real MariaDB), `tests/e2e/` (browser).
- **How a request is handled** — keep to this shape for every new feature:
  1. A screen (`src/app/(app)/**/page.tsx`) calls `requirePagePermission("…")` and then an operation in `src/server`.
  2. A form posts to a `"use server"` action, which does nothing but call `runAction()` (`src/server/action.ts`) and pass plain form fields to an operation.
  3. The operation (`src/server/business/*.ts`, or `src/server/platform/*.ts` for owner-only cross-business work) calls `authorize(context, "permission")` first, validates input with Zod via `parseInput`, and uses `businessDb(context)` — never the raw client.
  4. `tests/db/access.test.ts` lists **every** exported operation with who may call it; a test fails if an operation is missing from that list. Add each new operation there, with a `runAgainstB` case if it takes a record id.
- **Permissions:** `src/server/permissions.ts` is the one map. `tests/unit/permissions.test.ts` holds an independent copy of SPEC §5; both must change together, and only after SPEC.md changes.
- **Business scoping:** `src/server/db/scoped.ts`. When adding a table, add it to `BUSINESS_SCOPE` there (and to the `TRUNCATE` lists in `prisma/seed.ts` and `tests/support/world.ts`). ESLint forbids importing the raw client outside `src/server/db`, `src/server/auth`, `src/server/platform`.
- **Catalogue (M4):** `src/server/business/catalog.ts` (products, units, prices), `setup.ts` (locations, terminals), `settings.ts` (tax rate, receipt text, automatic sign-out). Form values for money, conversions and percentages are parsed with the helpers in `src/server/input.ts` and travel as exact decimal text. Rules worth remembering:
  - A unit's name and conversion are never edited: `retireUnit` + `addUnit`. `product_unit.activeName` (name while in use, NULL once retired) carries the unique index that stops two in-use units sharing a name.
  - Price and tax-rate changes use an "only if still the value I read" update (`updateMany` with the old value in `where`) plus an add-only history row; no raw SQL or row locks needed.
  - A whole-unit product (`allowsFraction = false`) only accepts whole-number conversions. `allowsFraction` and the base unit are fixed at creation.
  - New tables must carry `businessId` with `onUpdate: Restrict`, be added to `BUSINESS_SCOPE`, and pass `businessId: businessIdOf(context)` in `create` data (the scoped client overwrites it anyway; the type checker requires it).
  - Add-only tables so far: `activity_log`, `price_change`, `tax_rate_change`, `stock_movement`, `goods_receipt_version`, `goods_receipt_version_line`, `goods_receipt_change`, `stock_transfer`, `stock_transfer_line`, `stock_count`, `stock_count_line`, `stock_adjustment`, `stock_adjustment_line`, `stock_adjustment_decision`, `sale`, `sale_line`, `payment`, `sale_receipt_print` (triggers). Emptying them needs `TRUNCATE`.
  - Every new business gets a Shelf, a Storeroom and terminal `T1` (`src/server/business/defaults.ts`).
- **Stock (M5):** `src/server/business/stock.ts` and `suppliers.ts`. The rules every later stock feature (transfers, counts, sales, returns) must keep:
  - Stock changes only by writing `stock_movement` rows **and** the matching `stock_balance` change in the same transaction. `expectBalancesMatchMovements()` in `tests/support/world.ts` checks the whole database; call it in `afterEach` of every test file that moves stock.
  - Transactions that move stock run at `isolationLevel: "ReadCommitted"`, and take the product's "turn" first by touching the product row (`tx.product.update … updatedAt`) in **sorted product-id order**. MariaDB's default isolation would otherwise read a stale stock total after waiting, and the average cost came out wrong under simultaneous deliveries.
  - Balances are raised with `updateMany … increment` then `create` if no row existed. They must be lowered (M6, M8) with a single conditional update (`where: { quantity: { gte: x } }`) and the count checked; the database CHECK refuses a negative balance as the last line of defence.
  - Documents carry a browser-made `requestId` under a unique index; a repeat returns the saved document. Numbers come from `takeDocumentNumber(tx, businessId, kind)` (`src/server/document-number.ts`, table `document_counter`), called FIRST in the transaction (no gaps on failure). For a new kind of document add a value to the `DocumentKind` enum.
  - **Lock order — learned the hard way at M8, keep it for every stock transaction:** (1) the document's own counter or row (document counter, terminal, the delivery being corrected); (2) every product involved, by touching its row, in sorted id order; (3) balances, by location id; and only THEN write rows that refer to a product (lines, movements). Two mistakes caused real deadlocks between a delivery and a sale: the counters used to be columns of `business`, so a delivery held the business record locked while every sale needed a shared lock on it to insert its rows; and lines were inserted before the product's turn was taken, which holds a weak lock on the product and then asks for the strong one. Never lock the `business` row for the length of a stock transaction, and never put a counter on a record other work needs.
  - Every stock-changing operation retries up to 3 times on `P2034` (deadlock / write conflict). The retry is the safety net, not the design: `tests/db/sales.test.ts` "a busy shop" must pass without relying on it.
  - Document lines store snapshots: product name, unit name, conversion, quantity in the unit and in base units, cost.
  - Average cost: `movingAverageCost()` in `src/lib/money.ts`, stored per base unit to 4 decimal places on `product.averageCost`.
  - Date-only values (delivery date, expiry) are `@db.Date`, handled as `"YYYY-MM-DD"` text with `dayToDate` / `dateToDay` / `addMonths` from `src/lib/format.ts`; "today" is always `shopToday()`.
  - To empty tables in seed/tests use `emptyAllTables()` in `prisma/empty-tables.ts` and add every new table to its list.
  - A failure mid-transaction is tested by mocking `activityRow` to throw (`tests/db/stock-failure.test.ts`); copy that for transfers and sales.
  - The receive form (`stock/receive/receive-form.tsx`) is a client component that sends the whole delivery in one call; errors come back keyed `lines.N.field`. The first line has a fixed key so server and browser draw the same page.
  - The System check page confirms all add-only triggers and CHECK limits are installed; add new ones to `ADD_ONLY_TABLES` / `OTHER_TRIGGERS` / `REQUIRED_CHECKS` in `src/server/platform/system.ts` and to `tests/db/migrate-tool.test.ts`.
- **Transfers (M6):** `src/server/business/transfers.ts` (`getTransferOptions`, `transferStock`, `listTransfers`, `getTransfer`); screens under `src/app/(app)/stock/transfers/`. Tables `stock_transfer` and `stock_transfer_line` are add-only (triggers); CHECKs forbid a transfer to the same location and non-positive amounts. Each line writes a `TRANSFER_OUT` (negative) and a `TRANSFER_IN` (positive) movement; the average cost is not touched. The "from" balance is lowered with the conditional update; products that are short are collected and the whole transfer is refused with a message per line (`lines.N.quantity`). Numbers come from `business.nextStockTransferNumber` (`TR-000012`, `transferNumber()` in `src/lib/format.ts`). Making a transfer needs `stock.transfer`; reading the list and a transfer needs `report.stock.view` (no new permission was added). A transfer is not correctable: a mistake is reversed with another transfer.
- **Selling (M8):** `src/server/business/sales.ts` — `postSale` is the ONE place a sale is saved (offline sync at M12 must call it too), plus `getCheckoutCatalogue`, `listSales`, `getSale`, `recordReceiptPrint`. Screens: `src/app/(app)/sell/` (checkout) and `src/app/(app)/sales/` (list, sale page, `receipt.tsx`).
  - **The browser is never trusted about money.** The checkout sends each line's unit price and the total as the cashier saw them; the server uses its own prices and refuses the sale if a price or the total differs (this also catches a price changed since the page was loaded — the message says to get the latest prices). The checkout's own arithmetic uses the same `lineTotal` / `sumMoney` helpers, for display only.
  - **Order inside the transaction:** the terminal's counter first (`terminal.nextReceiptNumber`; this also queues sales from one terminal), then products in sorted id order (touch the row, read the average cost), then locations in sorted order with the conditional decrement; shortages are collected and the whole sale refused with a message per line. Then sale, lines, `SALE` movements (negative), and the payment LAST. Receipt number = `terminalCode-000012` (`saleReceiptNumber()`), unique per business.
  - **Snapshots on every line:** product name, unit name, conversion, quantity, base quantity, unit price, line total, taxable, tax rate, tax amount, average cost per base unit, line cost, location. The sale stores total, tax rate, tax total, cost total. Nothing is recomputed later. Tax: `taxIncludedIn(lineTotal, rate)` per taxable line.
  - `sale`, `sale_line`, `payment`, `sale_receipt_print` are add-only (triggers) with CHECKs on amounts (`payment`: cash change must equal tendered − amount). `PaymentMethod` has only `CASH` until M9. No till sessions yet (M9), no customer (M10), no discounts (M11).
  - Sales are **not** written to the activity log (it would drown everything else); reprints are. A mid-save failure is therefore tested with a temporary database trigger on `payment` (`tests/db/sales.test.ts`), not by mocking `activityRow`.
  - **Who sees sales:** `report.sales.view` sees all; otherwise `report.ownShift.view` sees only their own (`ownOnly()`); another person's sale is "not found". `costTotal` is returned only with `cost.view`.
  - **Checkout screen:** works from the catalogue copy passed as props and submits the whole sale in one call (rule "offline-readiness"). Keyboard: Enter on a match adds it and moves to "how many"; Enter there returns to search; Enter on an empty search goes to the cash box; Enter there completes. F2 = search, F4 = cash. The sale's `requestId` is made when the screen opens and replaced only after success. The terminal a computer uses is remembered in `localStorage` (`kuchpos_terminal`); with several terminals and nothing remembered, the checkout asks which one this computer is and will not complete a sale until told (it once silently took the first by code, and a browser test caught a sale numbered from another test's terminal).
  - **Receipt:** `.receipt-paper[data-width]` is 48 mm or 72 mm wide (printable width of 58 / 80 mm paper); the print rules in `globals.css` hide everything else with `visibility: hidden !important` (without `!important` the buttons still printed). `recordReceiptPrint` is called before every `window.print()`; the first print is the original, later ones are marked REPRINT and logged. Browser tests replace `window.print` with a counter.
  - Browser tests for selling are in `tests/e2e/tills-and-selling.spec.ts`; they rely on the stock left by `stock.spec.ts`, which runs first because files run in alphabetical order. Keep a selling spec's name after "stock".
- **Counts and adjustments (M7):** `src/server/business/counts.ts` (`getCountSheet`, `submitCount`, `listCounts`, `getCount`) and `adjustments.ts` (`getAdjustmentOptions`, `recordAdjustment`, `adjustFromCount`, `decideAdjustment`, `listAdjustments`, `getAdjustment`); screens under `src/app/(app)/stock/counts/` and `stock/adjustments/`; reasons in `src/lib/adjustment-reasons.ts`.
  - **A count changes no stock.** It stores, per counted product, what was counted (base units, plus "2 carton + 7 single" as entered), what the system held in that location at the moment of saving, and the difference. `getCountSheet` deliberately returns no stock figures (blind count); do not add them.
  - **An adjustment is a difference, never "set to N"**, so movements between entering and applying are kept. Lines are signed (negative = out) and carry a reason each; "Other" needs a note.
  - **Approval without updating anything:** `stock_adjustment` is add-only. Its status is derived: no row in `stock_adjustment_decision` = waiting; a row with `APPLIED` or `REJECTED` = decided. `adjustmentId` is unique there, so there can be only one decision; the decision row is written FIRST in the transaction (it is the lock), then the stock is changed. This is the pattern to reuse for discount approvals (M11) and returns (M13): the "approvals are add-only" rule holds without any status column.
  - Whoever holds `stock.adjust.approve` gets the decision written at once in `saveAdjustment`; others' adjustments wait. `applyToStock` nets all lines per product, takes the product's "turn" in sorted order, lowers with the conditional update, and refuses the whole thing listing every short product. Movements are type `ADJUSTMENT`, one per line, under the name of the person who applied it. Average cost is not changed.
  - `adjustFromCount` takes amounts only from the saved count lines (base unit), the browser sends only `{ lineNumber, reason }`; `stock_adjustment.countId` is unique (one adjustment per count; if rejected, count again).
  - Count form problems are keyed `lines.<productId>`; adjustment form problems `lines.<index>.<field>`; count-adjust form `lines.<lineNumber>.reason`.
  - Reading counts and adjustments needs `report.stock.view`. The home page shows approvers a notice when adjustments are waiting (`dashboard.adjustmentsWaiting`).
- **Sign-in form:** the Sign in button is disabled until the page is interactive and the form is `method="post"`. Before that fix, a click in the first instant after loading made the browser submit the form itself and put the password in the address bar. Keep both.
- **Correcting a delivery (C39):** `src/server/business/receipt-corrections.ts` (`correctReceipt`, `getCorrectionOptions`, `getReceiptHistory`); the line checks shared with receiving are in `src/server/receipt-lines.ts` (outside `business/` on purpose: a test requires every exported function in that folder to check a permission). This is the pattern for every later "correct a saved document" feature:
  - **What is the truth:** `stock_movement` (history) and `stock_balance` (running total). `goods_receipt` + `goods_receipt_line` are the paperwork **as it stands now**; they are no longer add-only. A trigger (`goods_receipt_guard_update`) refuses any update of a delivery that does not raise `version` by exactly one or that touches its id, business, number, request id or who/when it was entered; `goods_receipt_no_delete` remains.
  - **History:** `goods_receipt_version` (+ `_version_line`) holds a full snapshot of every version — version 1 is written by `receiveGoods`, and the migration back-filled it for older deliveries — and `goods_receipt_change` holds one row per changed field (label, old value, new value as people read them). All three are add-only (triggers). A CHECK requires a reason on every version above 1.
  - **Stock:** a correction writes `RECEIPT_CORRECTION` movements for the net difference per product and location (document type `goods_receipt_correction`, document id = the version row, number `GR-000012-C1`) and never touches earlier movements. Decreases use the conditional update; if not enough is there the whole correction is refused.
  - **Order of locks:** the delivery row first (conditional `updateMany` on `version`, which is also the "someone else got there first" check), then products in sorted id order, then locations in sorted id order. A deadlock (`P2034`) is retried up to 3 times.
  - **Lines:** identified by `lineNumber`, which is never reused within a delivery. A kept line's product cannot change (remove and add instead). Kept lines are updated in place, removed ones deleted, added ones inserted — do **not** delete-and-reinsert all lines: that deadlocked under simultaneous corrections. Whatever is left unchanged on a saved line is accepted as saved, even if the product, unit or supplier has since been taken out of use.
  - **Average cost:** `correctedAverageCost()` in `src/lib/money.ts`. A price change re-values only the part of the delivery that can still be in stock; with no stock left the average is unchanged.
  - `ReceiveForm` serves both screens; with the `correction` prop it is pre-filled and asks for the reason.
  - Not built (owner to decide): cancelling a whole delivery (a correction must keep at least one line), and requiring a second person's approval for large corrections (natural home: the approval mechanism of M7/M11).
- **List screens (C31) — follow this pattern for every new table:**
  - The operation takes `{ search, …filters, page }` and returns `{ rows } & Paged` using `PAGE_SIZE`, `pageNumber` and `paged()` from `src/server/paging.ts` (50 rows; order by a stable key plus `id`).
  - The page reads `searchParams`, renders `<LiveSearch>`, `<FilterSelect>`, `<FilterDate>`, `<FilterToggle>` (inside `<Suspense>`) from `src/components/filters.tsx`, and `<Pagination>` from `src/components/pagination.tsx`. Filters live in the address (`?q=…&category=…&page=2`), so the server still does the filtering and the permission check.
  - Date filters are whole shop days in Nigerian time: `shopDayStart` / `shopDayEnd` in `src/lib/format.ts`.
  - Two lessons built into `filters.tsx`, do not undo them: (1) the search box is uncontrolled and picks up letters typed before the page became interactive; (2) each filter change starts from the latest requested filters or the live address bar, never from a value remembered at render time — a delayed search once wiped two date filters that way.
- **Look and feel (C32), after the owner's reference design (2026-10-03):** soft grey page, white `rounded-3xl` panels with no border in light mode, pill buttons, lime primary (`--primary`) with dark text, deep-green gradient (`.bg-brand-gradient`) for highlight cards, logo and avatars.
  - Colours are CSS variables in `src/app/globals.css`, with a `.dark` set. **Links and coloured text on panels use `text-link`, never `text-primary`** (lime is unreadable as text on white).
  - Every screen starts with `<PageHeader>`; forms sit in `<Card>`; tables use the shared `<Table>`; empty states are `rounded-3xl border border-dashed p-10`.
  - `src/components/app-shell.tsx` is the frame: side menu that collapses to icons (`kuchpos_sidebar` cookie) and the top bar. `theme-toggle.tsx` switches light/dark (`kuchpos_theme` cookie, read in `src/app/layout.tsx` so the page is drawn in the right mode from the start). `user-menu.tsx` is the drop-down with Profile, Change password and Sign out. `side-nav.tsx` maps icon names from `navigation.ts`.
  - The home page (`src/app/(app)/page.tsx`) shows a greeting by shop time and snapshot figures from `src/server/business/dashboard.ts`, which returns `null` for any figure the role may not see. Add sales, collections and debt figures there as those milestones are built (placeholders are already shown to roles that will see them).
  - `/account` is the profile page (`getOwnProfile` in `src/server/auth/account.ts`).
  - `<ActionForm>` submits by hand (`onSubmit` + `startTransition`) on purpose: letting React handle the form empties every box after each attempt, so one mistake meant retyping everything. Keep it that way; `resetOnSuccess` clears a form only after it saved.
  - Text typed into a box before the page has finished loading is lost (React resets it). It only matters in the first instant after a full page load. Browser tests that type straight after opening a page use `gotoReady()`.
  - Browser tests: menu items via `openFromMenu()`, sign-out via `signOut()`, the drop-down via `openUserMenu()` (all in `tests/e2e/helpers.ts`).
- **Menu:** `src/server/navigation.ts`. Items with `href: null` show as "coming soon"; fill in the address when the screen is built.
- **After any successful action the whole page frame is refreshed** (`revalidatePath("/", "layout")` in `runAction`). Without it the shared header/menu stays stale. Actions look up the signed-in person fresh; pages use the per-request cached `requireContext()`.
- **Login notes:**
  - Better Auth's *admin* plugin is deliberately **not** used: its web endpoints know nothing about businesses, so one business's admin could list or reset users of another. Accounts are created/disabled/reset by our own operations, using the library only to hash and check passwords and to hold sessions.
  - Only three login addresses are exposed (`ALLOWED_AUTH_PATHS` in `src/server/auth/auth.ts`): sign in, sign out, get session. Everything else the library offers returns 404.
  - `role`, `businessId`, `disabledAt` and `session.activeBusinessId` are columns the library does not know about, so it can never write them.
  - A disabled account / deactivated business is refused at sign-in (session hook) **and** on every request (`resolveContext`).
  - The library needs an email per user; staff get a placeholder `username@users.kuchpos.invalid`.
  - Operations on a person's OWN account live in `src/server/auth/account.ts`, need no permission (any signed-in person), and take the account only from the session.
  - Sign-in rate limiting is the library's default (on in production, in-memory). In-memory limits do not work across serverless instances — switch to database storage at M3/M16.
- **shadcn/ui:** `button.tsx` came from the registry. `input`, `label`, `card`, `table`, `badge`, `alert`, `native-select` were written by hand in the same style because the registry site was unreachable on 2026-10-02. Replace them with registry versions only if there is a reason to.
- `src/lib/decimal.ts`, `money.ts`, `quantity.ts` are the **only** place money and quantity maths happens (rule 5). Parse with `parseMoney` / `parseQuantity`; never construct amounts from JavaScript numbers.
- decimal.js gotcha: `isPositive()` is true for zero. Use `greaterThan(0)`.
- Prisma 7.10 names its config file **`prisma7.config.ts`** (not `prisma.config.ts`). The generated client lives in `src/generated/prisma` (git-ignored; recreated by `npm install` / `npm run db:generate`). Import from `@/generated/prisma/client`; get the client with `getDb()` from `src/lib/db.ts`.
- `prisma init` downloads AI-agent "skill" folders (`.agents/`, `.windsurf/`, `.claude/skills/`, `skills-lock.json`). They were not asked for and were deleted. Do not run `prisma init` again.
- Local database: MariaDB 10.11.6 installed with the free DBngin app (user `root`, no password, port 3306). Databases `kuchpos_dev` and `kuchpos_test`. Its tools are at `/Users/Shared/DBngin/mariadb/10.11.6_intel/bin/` (e.g. `mariadb -h 127.0.0.1 -u root`). DBngin must be open with MariaDB started. Postgres.app is no longer used.
- **MariaDB rules of thumb** (learned during the switch):
  - `DATABASE_URL` is `mysql://USER:PASSWORD@HOST:PORT/DATABASE`. `src/server/db/client.ts` turns it into pool settings and runs `SET time_zone = '+00:00'` on every connection, so stored times are always UTC. Keep that for any new client (the seed script does the same).
  - Text comparison is **not case-sensitive** (collation `utf8mb4_unicode_ci`). Use `BINARY` in raw SQL or CHECKs when case matters.
  - No native UUID column in 10.6: ids are `CHAR(36)` (`@db.Char(36)`). Times are `@db.DateTime(3)`. A plain `String` is `VARCHAR(191)` — give longer text an explicit `@db.VarChar(n)` or `@db.Text`.
  - A column used in a `CHECK` must not belong to a foreign key that cascades on update: declare such relations with `onUpdate: Restrict`.
  - `CHECK` constraints and triggers are added by hand at the end of a migration file (Prisma cannot express them). Single-statement triggers only (`FOR EACH ROW SIGNAL SQLSTATE '45000' …`), so no `DELIMITER` is needed.
  - `TRUNCATE … CASCADE` does not exist. Emptying tables for seed/tests: `TRUNCATE` the add-only tables (triggers block `DELETE`), then `deleteMany()` the rest in child-to-parent order.
  - Raw SQL uses backticks for names. `SELECT … FOR UPDATE` works inside `$transaction`. Default isolation is REPEATABLE READ.
  - Not yet proven on the hosting server (check at M3): that the database user may create triggers, and that `prisma migrate deploy` runs there. If triggers are refused, say so to the owner; the add-only rule would then rest on the application alone.
  - Session tokens and ids are compared case-insensitively because of the collation. Acceptable (cookies are signed), but do not rely on case to distinguish values.
- **Deployment** is described step by step in [DEPLOY.md](DEPLOY.md); keep it accurate whenever the procedure changes. Pieces: `next.config.ts` (`output: "standalone"`), `scripts/build-deploy.mjs` (builds and zips; fails if this Mac's login secret ends up in the bundle), `hosting/app.js` (start-up file), `hosting/migrate.ts` (applies Prisma migration files on the server and records them in `_prisma_migrations` exactly as Prisma does — tested in `tests/db/migrate-tool.test.ts`), `hosting/env.example`.
- With `output: "standalone"`, `next start` no longer applies; a production build is started with `node .next/standalone/server.js` (the bundle's `app.js` does this). A full local rehearsal of the server procedure on Node 20 was done on 2026-10-02 (migrate, seed, start, sign in, rate limit, ~230 MB memory). Not yet proven: running under the host's Passenger launcher.
- **Sign-in rate limiting** is on in production only (or with `RATE_LIMIT=on`), stored in the `rateLimit` table: 10 sign-in attempts per minute per internet address (`SIGN_IN_ATTEMPTS_PER_MINUTE` overrides). Check on the host that the visitor's address is seen correctly (the `x-forwarded-for` header); if not, all visitors share one counter.
- `KUCHPOS_ENVIRONMENT=test` on a server shows the yellow TEST banner (`src/components/environment-banner.tsx`).
- **Hosting notes (HOSTAFRICA):** DirectAdmin at `ls11.host-ww.net:2222`, account `kuchcom` for `kuch99.com`, subdomain `pos.kuch99.com`. Application folder `domains/kuchpos` (application root in Setup Node.js App), start-up file `app.js`, database and database user both `kuchcom_kuchpos`. Web server is LiteSpeed. This account has no Terminal in the panel; `npm run migrate` / `npm run seed` are run with the **Run JS script** button on the application's page. A wildcard certificate `*.kuch99.com` covers the subdomain. Tools seen in the panel: Setup Node.js App (CloudLinux selector, runs the app under Passenger), phpMyAdmin, Terminal, Git, Cron Jobs, Backup and Restore, SSH Keys. The owner logs in; never ask for or handle the hosting password. Build on the Mac and upload; do not build on the server.
- Verified on 2026-10-02: a production build made on Node 24 starts and serves sign-in and pages under Node 20.19.4 (`npx node@20.19.4 node_modules/next/dist/bin/next start`). One production dependency (`kysely`, inside the login library) declares Node >=22 but worked in that test. Re-run this check after dependency upgrades while the host is on Node 20.
- This Mac is often heavily loaded by the owner's other apps (load average in the hundreds was seen). Browser tests therefore allow 90 seconds per test, retry once, and pre-open every screen in `tests/e2e/global-setup.ts`. When adding a screen, add its address to the `SCREENS` list there. A full local browser run can take 10 minutes or more.
- Browser tests wait up to 15 seconds per check (`expect.timeout` in `playwright.config.ts`): this Mac is slow when busy, and 5 seconds produced false failures.
- This Mac runs macOS 13 (Intel). Playwright's downloadable browsers do not support it, so `playwright.config.ts` uses the installed Google Chrome (`channel: "chrome"`). Do not run `playwright install`.
- `npm audit` reports high-severity advisories in `mysql2` and `deepmerge-ts`. Both are pulled in only by the Prisma command-line tool (a development tool; the app connects through the separate `mariadb` driver, not `mysql2`). The offered fix is `--force`, which would jump to the Prisma 8 release candidate — do not apply it. Re-check when upgrading Prisma.
- `@types/node` is pinned to 24 (Vitest 5 requires 22 or 24+; the generator's default of 20 conflicts).

## Decisions log

| Date | Decision |
|---|---|
| 2026-10-01 | Technical approach chosen (see table above). Planning documents created. No code yet. |
| 2026-10-01 | Batch 1 answered: Naira + kobo; tax is a setting, default 0%; multi-business, 5→20 shops; Windows; 58/80 mm receipts, barcode later; Excel import by admins. |
| 2026-10-01 | M1 started. Project scaffolded (Next.js 16.3.8, Prisma 7.10.0, Vitest 5, Playwright 1.63, shadcn/ui). |
| 2026-10-02 | M1 verified and tagged `m1`. Version history is under the name Chima Ezirim; GitHub repository: https://github.com/ezirimcc/kuchpos (private). |
| 2026-10-02 | M2 built. Design choices recorded under "Login notes". |
| 2026-10-02 | M2 verified by the owner and tagged `m2`. The owner accepted the automatic sign-out details (default 30 min, range 5–480 min, owners fixed at 30 min). |
| 2026-10-02 | Owner decided: automatic sign-out is an admin setting per business (Q23 → C24); everyone can change their own password (Q24 → C25). Both built into M2. Chosen by the assistant, owner informed: default 30 min, range 5–480 min, owners fixed at 30 min. |
| 2026-10-02 | Owner chose zero-budget hosting on the existing HOSTAFRICA shared plan (`pos.kuch99.com`) instead of Vercel + Neon, and approved switching the database from PostgreSQL to MariaDB. The PostgreSQL migrations from `m2` were replaced by one fresh MariaDB migration (they had only ever been applied to local databases). |
| 2026-10-02 | Test site first went live at https://pos.kuch99.com on Node.js 24.21.0. Added an owner-only System check page (not in the original SPEC; it exists to verify the hosting server after each upload). |
| 2026-10-02 | M3 verified and tagged `m3`. How the test site and the later live site will be kept apart (separate subdomain and database on the same account) is to be decided at M17. |
| 2026-10-03 | Owner asked for product categories, paging, filters, search-as-you-type and a modern look (C30–C32). Built into M4. |
| 2026-10-03 | Owner supplied a reference design; theme rebuilt after it, with light/dark switch, collapsible side menu, user drop-down, greeting dashboard with snapshot figures, profile page; menu item renamed "Products & Categories" (C32–C34). |
| 2026-10-03 | Owner asked for editing of one's own full name and username on the profile page (C34); built for every role, confirmed by current password and recorded in the activity log. M4 verified and tagged `m4`. |
| 2026-10-04 | M5 built: stock ledger, suppliers, receiving goods with cost, batch/expiry per product, backdating by admin/manager with note, expiring-soon setting, stock on hand. |
| 2026-10-06 | Owner asked for saved deliveries to be correctable without losing history or stock integrity (C39). Built: versions, field-by-field change records, compensating stock movements, reason required, admin/manager/owner only. Chosen by the assistant, owner to confirm: who may correct; no approval step yet; a whole delivery cannot be cancelled by correction; how a late cost correction affects the average cost. |
| 2026-10-07 | M5 verified by the owner, uploaded to the test site, tagged `m5`. Still for the owner to confirm: the four choices listed on 2026-10-06. |
| 2026-10-07 | M6 built: transfers between Storeroom and Shelf. Chosen by the assistant, owner informed: the transfers list is readable by whoever can read stock reports (admin, manager, accountant, storekeeper); a saved transfer cannot be corrected, only reversed by another transfer. |
| 2026-10-07 | M6 verified by the owner, uploaded, tagged `m6`. Owner answered the M7 questions "yes to all" (C40–C43). M7 built. Chosen by the assistant, owner informed: the reason list keeps the two extra reasons already in the SPEC (sample or gift, data entry error); one adjustment per count; adjustments do not change the average cost; counts and adjustments are readable by whoever reads stock reports. Also fixed: the sign-in form could put a password in the address bar if submitted in the first instant after loading. |
| 2026-10-07 | M7 verified and tagged `m7`. Owner answered Q14 (C44, C45). M8 built. Chosen by the assistant, owner informed: a "Sales" menu item (cashier: own sales; sales-report readers: all); a stale price refuses the sale rather than silently charging the new price; sales are not written to the activity log, reprints are; the first unit offered for a product at checkout is its smallest; a new tax-number setting sits with the receipt text. |
| 2026-10-07 | While testing M8: a delivery and a sale of the same product could deadlock. Fixed by moving document numbers from the business record to a `document_counter` table and by taking each product's turn before writing lines (all stock operations). |
| 2026-10-01 | Batch 2 answered: **no branches** — every shop is an independent business; **owner** role (several allowed) with full admin rights in all businesses; customers/staff not shared; prices tax-inclusive with per-product taxable flag; outages frequent → offline moved to M12, before go-live; one checkout computer per business. Permission table and defaults P1–P13 accepted. Milestones renumbered (M12 offline, M13 returns, M14 reports, M15 Excel import, M16 hardening, M17 live environment, M18 go-live). |
