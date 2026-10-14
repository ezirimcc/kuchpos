# KuchPos — What to do when something goes wrong

For the owners (Chima and **Peace**). Keep a printed copy with the hosting papers.
Technical details of uploading and setting up are in [DEPLOY.md](DEPLOY.md).

## Who and where

| What | Where |
|---|---|
| The live site | https://pos.kuch99.com (the test site, with sample data: https://test.kuch99.com) |
| Owners who can open every business and every owner page | Chima, Peace |
| Hosting (server, database, files, Cron Jobs) | HOSTAFRICA — DirectAdmin for `kuch99.com`; support through the HOSTAFRICA client area |
| Off-server backups | Backblaze B2 — the KuchPos backups bucket |
| Kept in the password manager, reachable by both owners | the HOSTAFRICA login · the Backblaze login · the **backup passphrase** · each owner's own KuchPos sign-in |

**The backup passphrase is the one thing that cannot be recovered.** Without it no KuchPos backup can be opened. Never change it, never share it in a chat or e-mail.

## A staff member leaves, or their password may be known to someone else

1. Sign in as an owner or the business's admin → **Staff**.
2. Find the person → **Disable**. They are signed out everywhere at once and cannot sign in again. Their sales and records stay, under their name.
3. If they only forgot their password: on the same page, reset it instead and tell them the new one in person.

## A checkout computer is lost or stolen

1. Disable (above) every account that was signed in on it, or reset their passwords.
2. Sales that were waiting on that computer and never sent are lost with it: compare the cash count with the sales list for that day and note the difference.

## The internet is down (at the shop)

- Keep selling: the checkout carries on by itself ("No internet — selling continues on this computer"). Receipts print as usual.
- Do **not** clear the browser's history or data, and do not sign out, until the sales have been sent.
- When the internet is back, keep the checkout open: the sign at the top right counts the waiting sales down to zero.
- At the end of the day, **"sales waiting to send" must be zero**. If one stays waiting, open the sign at the top right: it says why (often: the till at that checkout is closed — open it). Sales that were sent but had something unusual (a price, the stock, the clock) are listed for a manager under **Sales → Offline exceptions**.
- A manager then checks **Stock → Sold beyond stock** and the red "Unreconciled offline sales" notice on the home page.

## The power is down

The checkout computer and the receipt printer need power (a laptop, or a backup power unit). Nothing is lost on the server.

## The site does not open, or shows "Something went wrong"

1. Open https://pos.kuch99.com/api/health. "ok" means the app and its database are running.
2. If not: DirectAdmin → Setup Node.js App → the live application (`domains/kuchpos-live`) → **Restart**. Wait a minute and try again.
3. Owner menu → **Error log** shows what went wrong, with the time and the screen.
4. If it started right after uploading a new version: upload the previous zip again and restart (DEPLOY.md, "If something goes wrong").
5. If the server itself is down: contact HOSTAFRICA support. Meanwhile the checkouts keep selling without internet.

## Backups

- Owner menu → **Backups** shows every backup and whether it reached Backblaze B2. A red warning there means backups have stopped: look at the latest runs' messages, then at DirectAdmin → Cron Jobs.
- KuchPos copies everything every 2 hours from 8 am to 8 pm and every night. B2 keeps the 2-hourly copies for 7 days, the nightly ones for 30 days and one a month for a year.
- HOSTAFRICA also keeps its own daily backups of the whole hosting account (DirectAdmin → Backup and Restore).

## Restoring the records after a disaster

Only when records have really been lost or damaged (not for a single wrong sale — that is corrected inside KuchPos by cancelling or returning). At most about 2 hours of trading may need to be entered again.

1. **Stop the selling**: tell the shops to keep selling without internet (their sales wait on the checkout computers and are sent later).
2. DirectAdmin → MySQL Management → create a fresh database, e.g. `restore2` (→ `kuchcom_restore2`), with the live database's user.
3. File Manager → `domains/kuchpos-live/.env`:
   - `RESTORE_DATABASE_URL` → the new database.
   - `RESTORE_FILE` → which copy, e.g. `nightly/kuchpos-live-20261020T2330Z-nightly.kbk` (the names are listed on the Backups page and in Backblaze). Leave it out for the newest copy.
4. Setup Node.js App → the live application → **Run JS script** → `restore`. It must end with **RESTORE DRILL PASSED** (the same check as a drill).
5. In `.env`, set `DATABASE_URL` to the restored database (keep a note of the old line). Remove `RESTORE_FILE`. **Restart** the application.
6. Sign in, open **System check** (all rules enforced) and look at a few recent sales, stock and debts.
7. Let the shops reconnect: the waiting sales are sent and saved. Re-enter anything else done after the copy was made (deliveries, repayments, transfers).
8. Keep the old database untouched until everything is confirmed; then it can be deleted.

## Practising a restore (every few months)

Run JS script → `restore` on the live site with `RESTORE_DATABASE_URL` pointing at `kuchcom_restore` (never at the live database — the tool refuses that). It fetches the newest copy back from Backblaze B2, loads it into the spare database and checks it. It must end with **RESTORE DRILL PASSED**. Nothing on the live site changes.
