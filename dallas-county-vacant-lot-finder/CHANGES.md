# Changes in this reviewed build

Fixes applied during code review (November 2026). Behaviour changes are marked **[behaviour]**.

## Results you can trust
- A property whose DCAD detail page fails to load (or loads as an error page) is no longer
  reported as a vacant lot. It is skipped and counted in a warning.
- **[behaviour]** The automatic "MapCheck" only read DCAD's records, never imagery, yet marked
  lots `MapCheck - Vacant Lot`. It is now a *records pre-screen*: it flags lots whose records
  show a building and leaves the rest `Pending MapCheck` for a person to confirm.
- Re-running the pre-screen no longer overwrites statuses a person has set.
- If DCAD is unreachable the search now reports an error instead of "0 vacant lots".
- Stopped searches, scan limits and partial results are shown in a yellow warning.

## Search
- City "ALL DALLAS COUNTY" (an option in the dropdown) returned nothing. Fixed.
- An unrecognised city silently searched Dallas and then discarded every result. It now
  returns a clear error.
- Direction prefixes ("E 11th St") and street types ("Grand Ave" vs "Grand St") are handled;
  loose matches such as "ELMWOOD" for "ELM" are filtered out.
- **[behaviour]** The scan limit was ignored. It now works, and defaults to "No limit".
- Pressing Stop (or closing the tab) now stops the server from continuing to query DCAD.
- Every DCAD request has a 20 second timeout.

## Aerial view
- The parcel outline was drawn in the wrong place/shape whenever the lot was not 3:2.
  The image extent and the overlay now share the same geometry.
- When DCAD has no boundary for a parcel the app no longer shows an unrelated block of
  Dallas with a "TARGET PARCEL" box on it.
- Aerial year is configurable with `DCAD_IMAGERY_YEAR`.

## Export
- Map links were app-internal paths (`/api/dcad-map?...`). Exports now carry the public DCAD URL.
- Account numbers are exported as text so Excel/Sheets keep the 17 digits and leading zeros.
- A reviewer's note is exported in preference to the automatic text; new "Reviewed By" column.
- Removed the "Connect Google Sheet ID" box, which did not connect to anything.

## Smaller items
- Ctrl/Cmd shortcuts (Ctrl+S, Cmd+V) no longer trigger MapCheck decisions in the review window.
- Reviewer notes can now actually be typed in the review window.
- Input validation on the proxy endpoints; larger request limit for the pre-screen endpoint.

## Vercel-ready layout
- `server.ts` is split into `server/app.ts` (the API), `dev-server.ts` (local use) and
  `api/index.ts` (Vercel entry). `vercel.json` added.
- TypeScript pinned to 5.9: version 7 has no programmatic API, which Vercel's build needs.
- Optional shared password (`APP_PASSWORD`).
- Searches stop cleanly before the hosting time limit and report what was not inspected.

## Address import (new)
- New **Import addresses** tab: paste or upload addresses / account numbers and get the same results,
  details, aerial imagery, MapCheck review and export as a street search. Street search is unchanged.
- Shared `inspectAndPrescreen` step so street search and import use identical vacancy logic, and
  `gisFeatureToRecord` so both build records the same way.
- Import summary shows addresses not found and matched addresses that are not vacant candidates.
