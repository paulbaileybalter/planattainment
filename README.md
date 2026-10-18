# Balter Brewing — Production Plan Attainment

A password-gated dashboard that reads the **Weekly Production Plan Attainment**
Google Sheet automatically and shows daily + weekly plan-vs-actual attainment for:

- **Brewing** — DME Brew, Krones Brew (measured in number of brews)
- **Packaging** — Cartons, Kegs (measured in cases / kegs)

Each is broken down by SKU as well as by day and week total.

## How it works

- Everyone signs in with one shared password, gated by a Cloudflare Worker
  (same pattern as the Daily Packaging Handover / Logistics Daily Handover /
  13:30 Handover sites).
- **The data comes straight from the Google Sheet.** When the page opens, the
  browser asks the Worker's `/api/sheet` endpoint, which downloads the whole
  workbook from Google as .xlsx and passes it back. The page then reads it
  with the same parser that was used for manual uploads. Nothing is stored
  anywhere — the Google Sheet stays the single source of truth.
- The page re-reads the sheet every 5 minutes while it's open, when you come
  back to a tab that's been sitting in the background, and whenever you click
  **Refresh**. The bar under the header shows when it last updated.
- The workbook can contain many weeks' worth of tabs — the dashboard finds
  every `Plan for WC ######` / `Attainment of WC ######` pair automatically
  and lets you switch between weeks from the dropdown in the header.
- If the sheet can't be reached, the bar says why and a manual **upload**
  fallback opens, so the dashboard is never stuck.

## Repo structure

```
wrangler.jsonc       — Worker config (assets, SHEET_ID variable)
package.json         — just the wrangler dev dependency
src/worker.js         — the server: password gate + /api/sheet + static file fallback
public/               — the actual site (index.html, app.js, manifest, icons)
```

## Connecting the Google Sheet

The sheet's ID lives in `wrangler.jsonc` under `vars.SHEET_ID` (it's the long
string in the sheet's URL between `/d/` and `/edit`). Change it there if you
ever point the dashboard at a different sheet.

The Worker has to be allowed to read the sheet. There are two ways, and it
picks between them automatically:

### Option A — link sharing (default, no secrets)

1. Open the sheet → **Share** → under *General access* choose
   **Anyone with the link**, role **Viewer**.
2. That's it. The Worker downloads the sheet using the public export link.

Anyone holding the sheet's link can then view the whole workbook (including
staffing and maintenance on the Live Board), so keep that link to people who
should see it, and keep this repo **private**.

### Option B — service account (sheet stays private)

Use this if your Google admin blocks "Anyone with the link".

1. In Google Cloud, create a project (or use an existing one) and **enable the
   Google Drive API**.
2. Create a **service account** and download a JSON key for it.
3. In the sheet, click **Share** and add the service account's email address
   (`something@project.iam.gserviceaccount.com`) as a **Viewer**.
4. In the Worker's **Settings → Variables and Secrets**, add a secret named
   `GOOGLE_SERVICE_ACCOUNT_JSON` and paste the **entire contents** of the JSON
   key file as the value.

When that secret exists the Worker uses it and ignores link sharing, so you
can switch the sheet back to *Restricted* afterwards.

## Keeping the spreadsheet parseable

The dashboard reads your **Live Brewery Board copy-paste exactly as you already
do it today** — no new template needed — but the parser relies on a few things
staying consistent, all of which already match your current layout:

1. **Tab names**: `Plan for WC ######` and `Attainment of WC ######`, where
   `######` is the same code for a given week (e.g. `100826`) so the two tabs
   get paired up. Keep using the same numbering scheme you already use. Tabs
   with other names are ignored.
2. **Row 2** has `Date` in column A and the seven day dates starting in
   columns B, E, H, K, N, Q, T (i.e. the first column of each day's 3-column
   block) — this is already how the Live Board pastes in. The dates must be
   real dates, not text.
3. **Section labels in column A**, spelled the way they already are today:
   `DME Brew`, `KRONES Brew`, `Cartons`, `Kegs` (not case-sensitive), each
   starting a new block that runs until the next labelled row.
4. **Brew counts** are written as the SKU immediately followed by `X` and the
   number of brews, no space — e.g. `IPAX2`, `EAZYX4`, `HAZYX4`. An entry with
   no number after the X (e.g. `CPTX`) isn't counted.
5. **Packaging quantities** (Cartons/Kegs) sit in the **third column** of that
   day's 3-column block (SKU name, tank/BBT, quantity) — also already how the
   board is laid out. The dashboard adds up these row quantities; it does not
   use the board's "Weekly Keg production" / "Weekly Carton Production" cells.

Everything else on the board — staffing, maintenance, transfers, notes — is
ignored by the parser, so there's nothing to strip out before pasting.

If a week's `Attainment of WC ######` tab hasn't been filled in yet, the
dashboard shows the plan with a banner noting actuals are pending, rather
than erroring.

## One-time setup

### 1. Push this repo to GitHub

Create a new GitHub repo and push these files to it (**private** recommended —
the sheet ID is in `wrangler.jsonc`, and with Option A anyone with the sheet's
ID could open it).

### 2. Connect it to Cloudflare via Workers Builds (Git integration)

Drag-and-drop won't work here since a Worker script has to actually run —
this needs the Git-connected deploy path:

1. In the Cloudflare dashboard: **Workers & Pages → Create → Workers Builds**
   (or **Connect to Git** if prompted from the Workers overview).
2. Pick the GitHub repo you just created.
3. Build settings: no build command needed — Wrangler picks up
   `wrangler.jsonc` automatically. Leave the root directory as `/`.
4. Deploy. The first deploy will fail health checks until secrets are set
   (next step) — that's expected.

### 3. Set the two secrets

In the Worker's **Settings → Variables and Secrets**, add these as type
**Secret** (not Text):

| Name | Value |
|---|---|
| `SITE_PASSWORD` | The shared password your team will type in to get past the login screen |
| `SESSION_SECRET` | A long random string (e.g. generate one with `openssl rand -base64 32`) — used to sign session cookies. Don't reuse this across the sibling sites. |

(Plus `GOOGLE_SERVICE_ACCOUNT_JSON` only if you chose Option B above.)

After saving secrets, redeploy (or it may auto-redeploy) and the site should
come up behind the login screen.

## Local development

```
npm install
npm run dev
```

Add a `.dev.vars` file with `SITE_PASSWORD=...` and `SESSION_SECRET=...` for
local testing — it's gitignored, never commit it. Wrangler loads it
automatically.

## Using it day to day

- **Sign in**: everyone uses the same `SITE_PASSWORD`. The session lasts 7
  days per browser before it asks again.
- **Log out**: button in the top-right.
- **Updating the data**: just keep pasting into the Google Sheet as you do now
  (Plan tab on Monday, Attainment tab the following Monday). The dashboard picks
  it up within 5 minutes, or straight away if you click **Refresh**.
- **Week selector**: if the workbook has more than one week's tabs, switch
  between them from the dropdown in the header. Your selected week and day are
  kept when the data refreshes.
- **Day tabs**: click a day (or the bar for that day on any chart) to filter
  every card to that day's figures; click **Week** to see the cumulative
  total for the whole week.
- **SKU breakdown**: each of the four cards (DME Brew, Krones Brew, Cartons,
  Kegs) lists every SKU with planned vs. actual and an attainment percentage,
  for whichever day/week is currently selected.
- **Copy tiles for email**: copies the four top tiles for pasting into the 9AM
  handover email.

## If something isn't loading

- The bar under the header says what went wrong. "Isn't shared as 'Anyone with
  the link'" means the sheet's sharing needs changing (Option A) or the service
  account hasn't been added as a Viewer (Option B).
- Check the Worker's logs in the Cloudflare dashboard (Observability is enabled
  in `wrangler.jsonc`) — a 502 from `/api/sheet` is Google refusing the request.
- If the sheet is unreachable you can still open the **upload** section under
  the bar and drop in a downloaded copy of the workbook.

## Home screen / shortcut icon

Bookmarking the site or using "Add to Home Screen" (iOS or Android) shows the
smiley logo as the icon, labeled "Attainment." This relies on
`manifest.json` and `icon-192.png` / `icon-512.png` in `public/` alongside
`index.html`. The browser-tab and bookmark icon is `favicon.svg`.
