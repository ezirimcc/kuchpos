# KuchPos — security checklist

Completed for milestone M16 on 2026-10-12. Go through it again before go-live (M18) and after
any large change. Each line says what was checked and how it is kept true.

## Who may do what

- [x] **Every operation checks a named permission first.** A test reads every file in
  `src/server/business/` and fails if an exported operation does not call `authorize(…)`.
- [x] **Every operation is tried as every kind of person** (`tests/db/access.test.ts`): allowed
  roles get through, all others are refused, and a test fails if a new operation is not listed.
- [x] **Every form and button goes through `runAction`** (11 action files, 76 actions, all
  counted on 2026-10-12), which identifies the signed-in person afresh.
- [x] **Every screen checks sign-in and permission before reading anything** (no page under
  `src/app/(app)` without `requirePagePermission` / `requirePageContext`).
- [x] **Every address the app answers by itself** (`/api/…`, `/reports/export`) identifies the
  person and checks permission; those that change data also refuse requests from other sites.
  `/api/health` is the one open address and says only that the app is running.
- [x] **Nothing the browser sends about money is trusted:** prices, totals, discounts,
  approvals and the business are worked out or looked up again on the server.

## One business cannot see another

- [x] All reading and writing goes through the scoped data layer; lint rules forbid the raw
  database client outside three folders.
- [x] Every operation that takes a record's id is tried with a record of another business and
  must answer "not found".
- [x] The owner's overview and the error log are the only cross-business reads; they return
  figures or names per business, never mixed records.

## Signing in

- [x] Passwords are stored only as slow one-way hashes (the login library's scrypt); never logged.
- [x] Sign-in is limited to 10 tries a minute per internet address, kept in the database.
- [x] Sessions end after the business's idle time (owners: 30 minutes) and after 8 hours at most;
  disabling an account or business signs its people out on their next click.
- [x] Only three login addresses are exposed; everything else the login library offers answers 404.
- [x] A manager's password typed at a cashier's screen is checked on the server, with five
  wrong tries in ten minutes stopping further tries.

## History cannot be rewritten

- [x] Stock, sales, payments, debts, approvals and the activity log are add-only, enforced by
  database triggers; the System check page confirms after every upload that all are installed.
- [x] Used records cannot be deleted (foreign keys); only never-used ones can (C67).

## What comes in from outside

- [x] Every input is checked with a schema and refused, not silently corrected.
- [x] No hand-written SQL in the app (`$queryRaw` / `$executeRaw` are not used in `src/`).
- [x] Nothing typed by staff is ever shown as HTML (`dangerouslySetInnerHTML` is not used) or run.
- [x] Excel uploads: admin and owner only, .xlsx only, 5 MB, row limits, numbers read as exact
  text, formulas never worked out, all-or-nothing, the same file refused twice.
- [x] CSV downloads: a cell that starts with `=`, `+`, `-` or `@` is neutralised so that Excel
  cannot run it as a formula.

## The server and the browser

- [x] HTTPS only (redirect on the host; browsers told to insist for a year), no framing by
  other sites, no content-type guessing, the software is not advertised.
- [x] Secrets live only in `.env` files, which are not in version control; the upload bundle
  is checked for this Mac's login secret before it is zipped.
- [x] Errors shown to staff are plain sentences; technical details go to the server's log and
  the owners' Error log (C68), which stores no passwords, cookies, headers or form contents.

## The libraries the app is built from (checked 2026-10-12 with `npm audit`)

- [x] **`mariadb` (the database driver) raised from 3.4.5 to 3.4.7**, which closes six published
  weaknesses. One remains published against every 3.4 release (a crash during a kind of
  sign-in to the database, "ed25519 with zero-configuration TLS"); KuchPos does not use that
  kind of sign-in — the database is on the same server, reached without TLS. Move to 3.5.4 or
  later when the Prisma adapter allows it.
- [x] `mysql2` and `deepmerge-ts` are flagged but are not used by the running app: they come
  with the Prisma command-line tool and as an unused option of the login library. The offered
  "fix" would install a different major version of Prisma — do not apply it.
- [x] `braces` is flagged but comes with the `shadcn` design tool, used only when building.

## Still to do before go-live

- [ ] Run the automated tests against the hosting server's MariaDB 10.6 (M17).
- [ ] Separate live site and database, own backup copied off the server, a practised restore (M17).
- [ ] Try the app on Windows in Chrome and Edge, and print receipts at 58 mm and 80 mm (owner).
- [ ] A staff member new to the app completes a sale, a transfer and a repayment, and keeps
  selling through an outage (owner).
- [ ] Change every sample password and remove sample data on the live site (M17/M18).
