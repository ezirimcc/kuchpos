# KuchPos — Putting the app online (HOSTAFRICA)

The app is **built on the development Mac** and **uploaded** to the hosting server as one zip file.
Nothing is built or installed on the server. Secrets live only in a `.env` file on the server.

| What | Where |
|---|---|
| Control panel | DirectAdmin for the `kuch99.com` hosting account |
| | **LIVE site** (from M17, C79) | **TEST site** (sample data) |
|---|---|---|
| Address | `https://pos.kuch99.com` | `https://test.kuch99.com` (was `pos.kuch99.com` until M17) |
| Application folder (never inside `public_html`) | `domains/kuchpos-live` | `domains/kuchpos` |
| Database and database user | `kuchcom_live` | `kuchcom_kuchpos` |
| Spare database for restores | `kuchcom_restore` (shared; a restore empties it) | same |
| Yellow TEST banner | no | yes (`KUCHPOS_ENVIRONMENT="test"`) |
| Backups | every 2 hours 8 am–8 pm and nightly, by Cron Jobs, to Backblaze B2 | by hand only (for drills) |

Both: start-up file `app.js`, Node.js 24.21.0, own `.env` and own `BETTER_AUTH_SECRET`. Commands such as `migrate` run with **Setup Node.js App → the application → Run JS script** (this account has no Terminal); each application runs them on its own database.

## What is in the zip

| Item | Purpose |
|---|---|
| `app.js` | Start-up file. Loads `.env`, then starts the app |
| `build/` | The app itself |
| `migrations/` | Database structure changes, in order |
| `tools/migrate.cjs` | Applies any new database changes (`npm run migrate`) |
| `tools/seed.cjs` | TEST site only: wipes the database and loads sample data (`npm run seed`) |
| `tools/backup.cjs` | Makes an encrypted backup and sends it to Backblaze B2 (`npm run backup`; Cron Jobs run it with `daytime` or `nightly`) |
| `tools/restore.cjs` | Loads a backup into the spare restore database and checks it (`npm run restore`) |
| `tools/create-owner.cjs` | NEW live site only: creates the first owner with a one-time password (`npm run create-owner`) |
| `env.example` | Template for the `.env` file |
| `VERSION.txt` | Which version this is and when it was built |

## First-time setup (once)

1. **Database.** DirectAdmin → Databases → create a database and a database user for KuchPos. Use a password of letters and numbers only. Note the database name, user name and password.
2. **Folder.** File Manager → home folder → create a folder named `kuchpos`.
3. **Upload.** Upload `deploy/kuchpos-deploy.zip` into `kuchpos` and extract it there.
4. **Settings.** In `kuchpos`, copy `env.example` to `.env` and fill in every value (see the notes inside the file).
5. **Node.js application.** Setup Node.js App → Create Application: version 24.21.0, mode Production, application root `domains/kuchpos`, URL `pos.kuch99.com`, start-up file `app.js`. Do **not** run "NPM Install".
6. **Database structure.** Setup Node.js App → open the application → **Run JS script** → `migrate`.
7. **Sample data (TEST site only).** **Run JS script** → `seed`.
8. **HTTPS.** Make sure a certificate covers the address (the existing `*.kuch99.com` certificate does).
9. **Placeholder page.** File Manager → `domains/kuch99.com/public_html/pos` → delete `index.html` (keep `.htaccess`). Otherwise the front address shows DirectAdmin's placeholder instead of the app.
10. **Check.** Open `https://pos.kuch99.com/api/health` — it should say the app is ok and the database is connected.

11. **Keep the app awake.** The host puts the app to sleep when nobody has used it for a few minutes, and waking it takes many seconds. DirectAdmin → Cron Jobs → create a job that runs every 2 minutes (minute `*/2`, every other field `*`; it was every 5 minutes until 2026-10-12) with the command:
    `curl -fsS -m 60 https://pos.kuch99.com/api/health > /dev/null 2>&1`

## Live site, backups and restore (M17, C79)

### A. Moving the TEST site to `test.kuch99.com` (once)
1. On every checkout computer that has used the test site: open `https://pos.kuch99.com`, make sure the sign at the top right shows no sales waiting to send, and sign out.
2. DirectAdmin → Subdomain Management → create `test` (for `kuch99.com`). File Manager → `domains/kuch99.com/public_html/test` → delete `index.html` (keep `.htaccess` if there is one).
3. Setup Node.js App → the existing application (`domains/kuchpos`) → edit → Application URL `test.kuch99.com` → Save. If the panel does not allow changing the URL: note every setting, delete the application (NOT the folder), and create it again with the same folder and the new URL.
4. File Manager → `domains/kuchpos/.env` → `BETTER_AUTH_URL="https://test.kuch99.com"` → Save. Restart the application.
5. Open `https://test.kuch99.com/api/health` (ok) and sign in with a sample user: the yellow TEST banner shows.

### B. The LIVE site at `pos.kuch99.com` (once)
1. DirectAdmin → MySQL Management → create database `live` (it becomes `kuchcom_live`) with its own user and a password of letters and numbers only. Also create database `restore` (→ `kuchcom_restore`) and give the same user access to it.
2. File Manager → home → `domains` → create folder `kuchpos-live`. Upload the zip there and extract it.
3. Copy `env.example` to `.env` and fill it in: the live database, a NEW `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL="https://pos.kuch99.com"`, the backup lines (section C). **Delete** the `KUCHPOS_ENVIRONMENT`, `SEED_PASSWORD` and `SEED_CONFIRM` lines. Add the two `FIRST_OWNER_…` lines.
4. Setup Node.js App → Create Application: 24.21.0, Production, root `domains/kuchpos-live`, URL `pos.kuch99.com`, start-up file `app.js`. Do not run "NPM Install".
5. **Run JS script** → `migrate`, then → `create-owner`. Copy the one-time password it shows (into your password manager, not into chat), then delete the `FIRST_OWNER_…` lines from `.env`.
6. File Manager → `domains/kuch99.com/public_html/pos` → if an `index.html` is there, delete it (keep `.htaccess`). Restart the application.
7. Open `https://pos.kuch99.com`: padlock, no yellow banner. Sign in with the one-time password → Profile → Change password. Then Owners → add Peace as a second owner.
8. The keep-awake job already calls `https://pos.kuch99.com/api/health` every 2 minutes; nothing to change. (The test site may sleep.)

### C. Backups to Backblaze B2 (once; owner)
1. Create a Backblaze account (B2 Cloud Storage). Create a **private** bucket, e.g. `kuchpos-backups-<something only you know>`; turn on its default encryption if offered.
2. The bucket's **Lifecycle Settings** → custom rules (all three):
   | File name prefix | Days till hide | Days till delete |
   |---|---|---|
   | `daytime/` | 7 | 1 |
   | `nightly/` | 30 | 1 |
   | `monthly/` | 365 | 1 |
3. **Application Keys** → Add a New Application Key: name `kuchpos-backup`, access to **that bucket only**, type **Read and Write**, and **no** permission to delete files if the page offers that choice. Copy the keyID and applicationKey into the live site's `.env` (`B2_KEY_ID`, `B2_APPLICATION_KEY`) — and into the test site's `.env` for drills. The applicationKey is shown only once.
4. Choose a `BACKUP_PASSPHRASE` of at least 20 characters, keep it in your password manager (and make sure Peace can reach it), and put it in both `.env` files. **Without it no backup can be opened.** Never change it once backups exist.
5. Restart the application(s). **Run JS script** → `backup`: it must end with "Sent to Backblaze B2". In KuchPos, owner menu → **Backups** shows the run as "Stored".
6. DirectAdmin → Cron Jobs → two jobs for the LIVE site. The server clock is universal time (Lagos − 1 hour). `NODE` is the node program of the live application — the path shown at the top of its page in Setup Node.js App, ending in `/bin/node` (for example `/home/kuchcom/nodevenv/domains/kuchpos-live/24/bin/node`):
   - Every 2 hours, 8 am–8 pm Lagos: minute `0`, hour `7-19/2`, other fields `*`, command
     `cd /home/kuchcom/domains/kuchpos-live && NODE tools/backup.cjs daytime >> backups/backup.log 2>&1`
   - Nightly, 00:30 Lagos: minute `30`, hour `23`, other fields `*`, command
     `cd /home/kuchcom/domains/kuchpos-live && NODE tools/backup.cjs nightly >> backups/backup.log 2>&1`
7. The next day: owner menu → **Backups** should list the runs, all "Stored", and no red warning.

### D. Restore drill (before go-live, then every few months)
1. In the site's `.env`: `RESTORE_DATABASE_URL` points at `kuchcom_restore` (never at the site's own database — the tool refuses that, and refuses any database without "restore" in its name).
2. **Run JS script** → `restore`. It fetches the newest copy back from Backblaze B2, checks it is complete and genuine, empties `kuchcom_restore`, rebuilds it, loads every record and checks the stock and debt figures. It must end with **RESTORE DRILL PASSED**.
3. A real restore after a disaster is described in RUNBOOK.md.

## Uploading a new version (every update)

On the Mac:

1. `npm run check` and `npm run test:e2e` — everything must pass.
2. `npm run deploy:build` — creates `deploy/kuchpos-deploy.zip`.

On the server:

3. **Live site only: take a backup first** — Setup Node.js App → the live application → **Run JS script** → `backup` (it should end with "Sent to Backblaze B2").
4. File Manager → the application folder → delete the old `build`, `migrations` and `tools` folders (keep `.env`).
5. Upload the new zip into the application folder and extract it, replacing files. Do the TEST site first, try it there, then the live site.
6. Setup Node.js App → open the application → **Run JS script** → `migrate`.
7. **Restart** the application.
8. Open `/api/health`, then sign in as an owner and open **System check**: the version should be the new one and every rule should say "Enforced".
9. **Selling without internet** (from M12): on each checkout computer, sign in as the cashier and open **Sell** once after every update, and leave it open for a minute — the sign at the top right should say **Online**. That is what makes the computer ready for an outage (it fetches the prices and keeps a copy of the offline checkout). It only works over `https://`. To check: switch the Wi‑Fi off and reload the page — the yellow "No internet — selling continues on this computer" bar should appear.

Never delete the `backups` folder or `.env` in an application folder.

Never run `npm run seed` on the live site: it wipes the database. It refuses to run unless `SEED_CONFIRM` in `.env` names the database, and that line must not exist on the live site.

## If something goes wrong

- **The page shows an error after an update:** in Setup Node.js App, check the application is started and on the right Node.js version; look at the log file named there. Re-uploading the previous zip and restarting returns the app to the previous version (database changes are not undone — restore the backup if a database change was the problem).
- **`npm run migrate` reports a failure:** do not retry. Note the message exactly; the tool refuses to continue until the cause is understood.
- **Too many sign-in attempts:** an address that makes more than 10 sign-in attempts in a minute is told to wait a minute.

## Running the browser tests against the online TEST site

Sample data must be loaded there. Because the tests sign in many times a minute, temporarily add
`SIGN_IN_ATTEMPTS_PER_MINUTE="200"` to the server's `.env`, restart, run the tests, then remove the line and restart again.

```bash
E2E_BASE_URL=https://test.kuch99.com SEED_PASSWORD='the sample password set on the server' npm run test:e2e
```
