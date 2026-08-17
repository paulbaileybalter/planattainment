# Balter Brewing — Production Plan Attainment

A password-gated dashboard that reads your **Weekly Production Attainment** workbook
and shows daily + weekly (previous week cumulative) plan-vs-actual attainment for:

- **Brewing** — DME Brew, Krones Brew (measured in number of brews)
- **Packaging** — Cartons, Kegs (measured in cases / kegs)

Each is broken down by SKU as well as by day and week total.

## How it works

- Everyone signs in with one shared password, gated by a Cloudflare Worker
  (same pattern as the Daily Packaging Handover / Logistics Daily Handover /
  13:30 Handover sites).
- **There is no server-side data storage.** The workbook you upload is parsed
  entirely in your browser using SheetJS — it never leaves your device, and
  nothing is written to a database. That means each person who wants to see
  the dashboard uploads the workbook themselves, and refreshing the page
  clears it. If you'd like this to instead sync automatically for everyone
  once someone uploads it (like the sibling sites' multi-device sync), that's
  a small follow-up — just ask.
- The workbook can contain many weeks' worth of tabs — the dashboard finds
  every `Plan for WC ######` / `Attainment of WC ######` pair automatically
  and lets you switch between weeks from the dropdown in the header.

## Repo structure

```
wrangler.jsonc       — Worker config (points at src/worker.js and public/)
package.json         — just the wrangler dev dependency
src/worker.js         — the entire server: password gate + static file fallback
public/               — the actual site (index.html, app.js, manifest, icons)
```

## Keeping the spreadsheet parseable

The dashboard reads your **Live Brewery Board copy-paste exactly as you already
do it today** — no new template needed — but the parser relies on a few things
staying consistent, all of which already match your current layout:

1. **Tab names**: `Plan for WC ######` and `Attainment of WC ######`, where
   `######` is the same code for a given week (e.g. `100826`) so the two tabs
   get paired up. Keep using the same numbering scheme you already use.
2. **Row 2** has `Date` in column A and the seven day dates starting in
   columns B, E, H, K, N, Q, T (i.e. the first column of each day's 3-column
   block) — this is already how the Live Board pastes in.
3. **Section labels in column A**, spelled the way they already are today:
   `DME Brew`, `KRONES Brew`, `Cartons`, `Kegs` (not case-sensitive), each
   starting a new block that runs until the next labelled row.
4. **Brew counts** are written as the SKU immediately followed by `X` and the
   number of brews, no space — e.g. `IPAX2`, `EAZYX4`, `HAZYX4`. This is
   already how you write them.
5. **Packaging quantities** (Cartons/Kegs) sit in the **third column** of that
   day's 3-column block (SKU name, tank/BBT, quantity) — also already how the
   board is laid out.

Everything else on the board — staffing, maintenance, transfers, notes — is
ignored by the parser, so there's nothing to strip out before uploading.

If a week's `Attainment of WC ######` tab hasn't been filled in yet, the
dashboard shows the plan with a banner noting actuals are pending, rather
than erroring.

## One-time setup

### 1. Push this repo to GitHub

Create a new GitHub repo and push these files to it (a private repo is
recommended, though nothing sensitive lives in the code itself since secrets
are set separately in Cloudflare).

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
- **Upload**: drop the Weekly Production Plan Attainment workbook onto the
  upload card, or click it to choose a file. This has to be done again each
  time you (or anyone else) opens the dashboard, since nothing is stored.
- **Week selector**: if the workbook has more than one week's tabs, switch
  between them from the dropdown in the header.
- **Day tabs**: click a day (or the bar for that day on any chart) to filter
  every card to that day's figures; click **Week** to see the cumulative
  total for the whole week.
- **SKU breakdown**: each of the four cards (DME Brew, Krones Brew, Cartons,
  Kegs) lists every SKU with planned vs. actual and an attainment percentage,
  for whichever day/week is currently selected.

## Home screen / shortcut icon

Bookmarking the site or using "Add to Home Screen" (iOS or Android) shows the
smiley logo as the icon, labeled "Attainment." This relies on
`manifest.json` and `icon-192.png` / `icon-512.png` in `public/` alongside
`index.html`.
