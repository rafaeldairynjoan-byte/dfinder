# Dallas County Vacant Residential Lot Finder

Find and verify vacant residential lots in Dallas County using live Dallas Central
Appraisal District (DCAD) public records and DCAD's official aerial/parcel map layers.

The app runs an Express + Vite server that queries DCAD's public `SearchAddr.aspx`
portal and GIS parcel services directly (no API key required), reads each result's
improvement value / building area from DCAD's records, and lists candidate vacant
lots.

## How a lot gets its status

1. **Search** - every residential account on the street is pulled from DCAD and kept
   if DCAD shows a $0 / N/A improvement value or a vacant class/use.
2. **Records pre-screen (automatic)** - lots whose DCAD records show a building are
   flagged `MapCheck - Had Structures`. Everything else stays `Pending MapCheck`.
   This step does **not** look at aerial imagery.
3. **MapCheck (a person)** - a reviewer confirms each lot on the aerial map and sets
   `MapCheck - Vacant Lot`, `MapCheck - Had Structures` or `MapCheck - Unclear`.

If DCAD cannot be reached, or some properties cannot be read, the app says so in a
yellow warning above the results instead of reporting "no vacant lots".

## Import addresses

Besides searching a whole street, the **Import addresses** tab checks specific addresses:

- Paste one address per line (`2800 Pennsylvania Ave, Dallas, TX 75215`), or upload a `.csv` / `.txt`
  file. A CSV with an `Address` column (and optional `City`, `Zip`, `Account` columns) works, as do
  bare 17-digit DCAD account numbers.
- Each address is matched to its DCAD parcel, then goes through exactly the same checks as a street
  search: detail-page verification, the $0 / N/A / vacant criteria, the records pre-screen, DCAD aerial
  imagery and the MapCheck viewer, with the same table, statuses and export.
- A summary lists addresses that were **not found** and addresses that matched but are **not vacant
  candidates** (with the reason), so nothing disappears silently.
- Up to 500 addresses per import; the same time limit and Stop button apply.
- API: `POST /api/import/stream` (live progress) and `POST /api/import` (JSON), body
  `{ "addresses": ["..."], "city": "Dallas" }`.

## Prerequisites

- Node.js 22.x

## Run Locally

1. Install dependencies:
   `npm install`
2. Run the app:
   `npm run dev`
3. Open the printed local URL in your browser.

## Deploy to Vercel

The project is already laid out for Vercel: the web page is built by Vite and served as
static files, and every `/api/...` request runs `api/index.ts` (the Express app in
`server/app.ts`). `vercel.json` holds the settings, so there is nothing to configure.

1. Put this folder in a GitHub repository.
2. In Vercel choose **Add New > Project** and import the repository. Leave every build
   setting as detected.
3. Recommended: under **Settings > Environment Variables** add `APP_PASSWORD` with a
   password of your choice, then redeploy. The site then asks for it (any username).
   Without it, anyone who finds the address can run searches through your deployment.
4. Open the address Vercel gives you and search a street you know.

Things to know on Vercel:

- **Time limit.** A request can run for 300 seconds on the Hobby plan. A search stops
  itself at 270 seconds and shows a warning with what it found so far. Very long streets
  may need a narrower search (add the direction or street type) or a higher plan.
- **Nothing is stored.** Review decisions live in the browser tab; export before closing.
- If searches return a "Could not reach DCAD" error on Vercel but work on your computer,
  DCAD is refusing connections from Vercel's servers and the app needs a different host.

## Build for production

`npm run build` outputs a production bundle to `dist/`. Run the server with
`NODE_ENV=production npm start` to serve it from your own machine.

No environment variables are required to run this app.

Optional:

- `PORT` - port to listen on (default 3000, local only).
- `APP_PASSWORD` - shared password for the API (off when unset).
- `SEARCH_TIME_BUDGET_SECONDS` - stop a search after this long and return partial
  results (default 270 on Vercel, no limit locally; 0 = no limit).
- `DCAD_IMAGERY_YEAR` - which DCAD aerial flight to use (default `2026`). Change it
  when DCAD publishes a newer `Imagery<year>` service.
