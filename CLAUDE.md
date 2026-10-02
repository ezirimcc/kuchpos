# KuchPos — Project Rules for Development Sessions

KuchPos is a POS and inventory web application for agricultural products shops in Nigeria. It is **multi-business**: each shop is an independent business, fully separate from the others (5 today, up to ~20). There is **no branch level**. **Owners** sit above the businesses.
Read [SPEC.md](SPEC.md) (what to build) and [PLAN.md](PLAN.md) (in what order) before doing any work.

Next.js's own rules for coding agents are in AGENTS.md (kept up to date by `next dev`) and are part of these instructions:

@AGENTS.md

## Current status

- **M1 (project skeleton) is done** — verified by the owner on 2026-10-02, committed and tagged `m1`. **Next: M2** (businesses, owners, sign-in, staff accounts and permissions).
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
| Runtime | Node.js 24 LTS |
| App framework (interface + server) | Next.js 16.3 (App Router, TypeScript, Turbopack), React 19 |
| Styling / components | Tailwind CSS 4, shadcn/ui |
| Database | PostgreSQL 17 or 18 (local: Postgres.app; hosted: Neon) |
| Database toolkit | Prisma ORM **7.10.x** with `@prisma/adapter-pg` |
| Login | Better Auth 1.7 (username + admin plugins), sessions in our database |
| Validation | Zod 4 |
| Exact arithmetic | decimal.js 10 |
| Tests | Vitest 5, Playwright |
| Offline (M12) | Dexie 4 (IndexedDB), Serwist 9 (service worker) |
| Hosting | Vercel (paid plan — free plan is non-commercial only) + Neon, same region |
| Package manager | npm |

Version rules:

- **Pin Prisma to 7.x.** On npm the `latest` tag currently points at an 8.0 release candidate, so `npm install prisma` alone installs the wrong thing. Always install `prisma@7` and `@prisma/client@7`. Better Auth 1.7 supports Prisma 5–7 only. Revisit only when Prisma 8 is stable *and* Better Auth supports it.
- Before adding or upgrading any dependency, check its current official documentation and `npm view <package> dist-tags`. Do not rely on memory for APIs — these tools change quickly. Next.js ships its docs inside `node_modules/next/dist/docs/`; prefer those for the installed version.
- Use stable releases only. No release candidates, betas or "experimental" flags in anything that touches money or stock.
- Use no hosting-specific features that would prevent running the app as a plain Node.js server elsewhere.
- When scaffolding at M1, `create-next-app` generates its own `AGENTS.md` and a `CLAUDE.md`. **Merge** them into this file; never let them overwrite it. (Scaffold in a temporary folder and move files in.)

## Confirmed facts that shape the code

- **Currency:** Nigerian Naira with kobo. Money is `NUMERIC(14,2)`; display as `₦1,250.00`. No cash rounding beyond the kobo.
- **Tax:** a per-business setting, default **0%**, changeable by the admin, with a change history. Each sale line snapshots its tax rate and amount. Prices are **tax-inclusive**; each product has a `taxable` flag. Line tax = line total × rate ÷ (100 + rate), rounded half-up to the kobo, for taxable products only; the customer always pays the shelf price.
- **Structure:** Platform → Business → Locations (Shelf, Storeroom) and Terminals. **No branch level — do not add one.** Products, prices, stock, customers, debts, staff, settings and reports all belong to exactly one business. Nothing is shared or moved between businesses.
- **Roles:** five business roles (admin, manager, accountant, cashier, storekeeper), each account tied to exactly one business; plus **owner**, which is not tied to a business. Owners (there can be several) create/deactivate businesses, create other owners, can open any business with full admin rights, and see an all-businesses overview. The last owner cannot be disabled.
- **Outages are frequent**, so offline checkout (M12) is required before go-live. One checkout computer per business today; design for more.
- **Time zone:** Africa/Lagos for display and for "business day" boundaries.
- **Clients:** Windows checkout computers, Chrome/Edge. Receipts via browser print at **58 mm or 80 mm** (per-terminal setting). Barcode is an optional product field; a scanner is just keyboard input.
- **Excel import** by business admins and owners, always into one business (SPEC §4.8, PLAN M15).

## Engineering rules (non-negotiable)

### 0. Businesses are sealed off from each other
- Every business-owned table has a `businessId`. Uniqueness rules (product codes, receipt numbers, customer codes, terminal codes) are scoped to the business, not global. Usernames are the one exception: unique across the whole system.
- For staff, the business comes **only from the signed-in session**, never from anything the browser sends. For an owner, the "business currently open" is chosen by the owner, stored server-side with the session, and re-checked on every request (the business must exist; the user must still be an active owner).
- Owner actions inside a business are written to that business's activity log under the owner's own name. Owner-only actions (create business, create owner, overview) are checked as owner-only on the server.
- All data access goes through one scoped data-access layer that applies the business filter. Screens and actions never query the database client directly. The owner overview is the only cross-business read; it lives in its own clearly named module and returns per-business figures, never mixed rows.
- A record fetched by ID must also match the session's business; a mismatch is reported as "not found".
- Every server action has a cross-business test (PLAN M2). The seed always contains one owner and two businesses.
- If KuchPos is ever offered to outside businesses, add PostgreSQL row-level security as a second layer before doing so.

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
- Database: `NUMERIC` columns with explicit precision — money to 2 decimal places (kobo), quantities and conversion factors to 3 decimal places. Never Prisma's default `Decimal(65,30)`; always specify `@db.Decimal(p, s)`.
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
- Stock, money, permission and approval logic are tested against a **real PostgreSQL database**, not a fake, because the guarantees depend on the database.
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

*Loading sample data (seed) is added at M2.*

## Project layout and local setup notes

- `src/app/` screens and routes · `src/lib/` shared server/business code · `src/components/ui/` shadcn components · `prisma/` database schema and migrations · `tests/unit/`, `tests/e2e/` tests (unit tests may also sit next to the code as `*.test.ts`).
- `src/lib/decimal.ts`, `money.ts`, `quantity.ts` are the **only** place money and quantity maths happens (rule 5). Parse with `parseMoney` / `parseQuantity`; never construct amounts from JavaScript numbers.
- decimal.js gotcha: `isPositive()` is true for zero. Use `greaterThan(0)`.
- Prisma 7.10 names its config file **`prisma7.config.ts`** (not `prisma.config.ts`). The generated client lives in `src/generated/prisma` (git-ignored; recreated by `npm install` / `npm run db:generate`). Import from `@/generated/prisma/client`; get the client with `getDb()` from `src/lib/db.ts`.
- `prisma init` downloads AI-agent "skill" folders (`.agents/`, `.windsurf/`, `.claude/skills/`, `skills-lock.json`). They were not asked for and were deleted. Do not run `prisma init` again.
- Local database: Postgres.app (PostgreSQL 18), database `kuchpos_dev`, no password, connection in `.env`. Its tools are at `/Applications/Postgres.app/Contents/Versions/latest/bin/`.
- This Mac runs macOS 13 (Intel). Playwright's downloadable browsers do not support it, so `playwright.config.ts` uses the installed Google Chrome (`channel: "chrome"`). Do not run `playwright install`.
- `npm audit` reports high-severity advisories in `mysql2` and `deepmerge-ts`. Both are pulled in only by the Prisma command-line tool (a development tool; the app uses PostgreSQL, never MySQL). The offered fix is `--force`, which would jump to the Prisma 8 release candidate — do not apply it. Re-check when upgrading Prisma.
- `@types/node` is pinned to 24 (Vitest 5 requires 22 or 24+; the generator's default of 20 conflicts).

## Decisions log

| Date | Decision |
|---|---|
| 2026-10-01 | Technical approach chosen (see table above). Planning documents created. No code yet. |
| 2026-10-01 | Batch 1 answered: Naira + kobo; tax is a setting, default 0%; multi-business, 5→20 shops; Windows; 58/80 mm receipts, barcode later; Excel import by admins. |
| 2026-10-01 | M1 started. Project scaffolded (Next.js 16.3.8, Prisma 7.10.0, Vitest 5, Playwright 1.63, shadcn/ui). |
| 2026-10-02 | M1 verified and tagged `m1`. Version history is under the name Chima Ezirim; GitHub repository: https://github.com/ezirimcc/kuchpos (private). |
| 2026-10-01 | Batch 2 answered: **no branches** — every shop is an independent business; **owner** role (several allowed) with full admin rights in all businesses; customers/staff not shared; prices tax-inclusive with per-product taxable flag; outages frequent → offline moved to M12, before go-live; one checkout computer per business. Permission table and defaults P1–P13 accepted. Milestones renumbered (M12 offline, M13 returns, M14 reports, M15 Excel import, M16 hardening, M17 live environment, M18 go-live). |
