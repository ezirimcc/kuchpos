# KuchPos — Putting the app online (HOSTAFRICA)

The app is **built on the development Mac** and **uploaded** to the hosting server as one zip file.
Nothing is built or installed on the server. Secrets live only in a `.env` file on the server.

| What | Where |
|---|---|
| Control panel | DirectAdmin for the `kuch99.com` hosting account |
| Address of the test site | `https://pos.kuch99.com` |
| Application folder on the server | `domains/kuchpos` (never inside `public_html`) |
| Start-up file | `app.js` |
| Node.js version | 24.21.0 |
| Database | MariaDB; database and user `kuchcom_kuchpos`, used only by KuchPos |
| Running `migrate` / `seed` | **Setup Node.js App → the application → Run JS script** (this account has no Terminal) |

## What is in the zip

| Item | Purpose |
|---|---|
| `app.js` | Start-up file. Loads `.env`, then starts the app |
| `build/` | The app itself |
| `migrations/` | Database structure changes, in order |
| `tools/migrate.cjs` | Applies any new database changes (`npm run migrate`) |
| `tools/seed.cjs` | TEST site only: wipes the database and loads sample data (`npm run seed`) |
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
8. **HTTPS.** SSL/TLS Certificates → issue a free Let's Encrypt certificate for `pos.kuch99.com`.
9. **Check.** Open `https://pos.kuch99.com/api/health` — it should say the app is ok and the database is connected.

## Uploading a new version (every update)

On the Mac:

1. `npm run check` and `npm run test:e2e` — everything must pass.
2. `npm run deploy:build` — creates `deploy/kuchpos-deploy.zip`.

On the server:

3. **Live site only: take a database backup first** (DirectAdmin → Backup and Restore).
4. File Manager → `kuchpos` → delete the old `build`, `migrations` and `tools` folders (keep `.env`).
5. Upload the new zip into `kuchpos` and extract it, replacing files.
6. Setup Node.js App → open the application → **Run JS script** → `migrate`.
7. **Restart** the application.
8. Open `/api/health`, then sign in as an owner and open **System check**: the version should be the new one and every rule should say "Enforced".

Never run `npm run seed` on the live site: it wipes the database. It refuses to run unless `SEED_CONFIRM` in `.env` names the database, and that line must not exist on the live site.

## If something goes wrong

- **The page shows an error after an update:** in Setup Node.js App, check the application is started and on the right Node.js version; look at the log file named there. Re-uploading the previous zip and restarting returns the app to the previous version (database changes are not undone — restore the backup if a database change was the problem).
- **`npm run migrate` reports a failure:** do not retry. Note the message exactly; the tool refuses to continue until the cause is understood.
- **Too many sign-in attempts:** an address that makes more than 10 sign-in attempts in a minute is told to wait a minute.

## Running the browser tests against the online TEST site

Sample data must be loaded there. Because the tests sign in many times a minute, temporarily add
`SIGN_IN_ATTEMPTS_PER_MINUTE="200"` to the server's `.env`, restart, run the tests, then remove the line and restart again.

```bash
E2E_BASE_URL=https://pos.kuch99.com SEED_PASSWORD='the sample password set on the server' npm run test:e2e
```
