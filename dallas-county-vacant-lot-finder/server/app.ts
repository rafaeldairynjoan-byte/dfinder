// The Express app: every /api route. No listening and no static files here, so the
// same app runs locally (dev-server.ts) and on Vercel (api/index.ts).
import express from 'express';
import { timingSafeEqual } from 'node:crypto';
import {
  DALLAS_COUNTY_CITIES,
  findCityCode,
  queryDCADParcelServer,
  fetchDCADDetailPage,
  searchDCADWebAddrAllPages,
  fetchParcelSnapshot,
  fetchWithTimeout,
  DCAD_USER_AGENT,
  officialMapUrl,
  parseAddressLine,
  lookupParcelsForAddress,
  type ParsedAddress,
} from './dcadService.js';
import { runAutoMapCheck } from './autoMapCheck.js';
import type { PropertyRecord, ImportSummary } from '../src/types/property.js';


// DCAD publishes one aerial service per year (Imagery2026, Imagery2027, ...). Set
// DCAD_IMAGERY_YEAR when DCAD releases a new flight instead of editing code.
const IMAGERY_YEAR = /^\d{4}$/.test(process.env.DCAD_IMAGERY_YEAR || '')
  ? (process.env.DCAD_IMAGERY_YEAR as string)
  : '2026';

/** DCAD account numbers are short alphanumeric ids. Reject anything else before proxying. */
function isValidAccountNumber(id: string): boolean {
  return /^[A-Za-z0-9]{1,30}$/.test(id);
}

/** Validate "minX,minY,maxX,maxY" and return it normalized, or null. */
function parseBbox(raw: string): string | null {
  const parts = raw.split(',').map((p) => Number(p.trim()));
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) return null;
  if (!(parts[2] > parts[0]) || !(parts[3] > parts[1])) return null;
  return parts.join(',');
}

/** Validate "width,height" (capped) and return it normalized, or the default. */
function parseSize(raw: string): string {
  const parts = raw.split(',').map((p) => Math.floor(Number(p.trim())));
  if (parts.length !== 2 || parts.some((n) => !Number.isFinite(n) || n < 16 || n > 2048)) {
    return '900,600';
  }
  return parts.join(',');
}

// How long one search may run before it stops and returns what it has.
// On Vercel a request is ended at the plan's limit (300 s on Hobby), so default to 270 s
// there; locally there is no limit. Override with SEARCH_TIME_BUDGET_SECONDS.
const SEARCH_TIME_BUDGET_MS = (() => {
  const fromEnv = Number(process.env.SEARCH_TIME_BUDGET_SECONDS);
  if (Number.isFinite(fromEnv) && fromEnv >= 0) return fromEnv * 1000;
  return process.env.VERCEL ? 270_000 : 0;
})();

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export function createApp() {
  const app = express();

  // Optional shared password. Set APP_PASSWORD (for example in Vercel's Environment
  // Variables) and every API call needs it; the browser shows its normal sign-in box.
  // Any username works. Leave it unset to run without a password.
  const APP_PASSWORD = process.env.APP_PASSWORD || '';
  if (APP_PASSWORD) {
    app.use((req, res, next) => {
      const header = req.headers.authorization || '';
      if (header.startsWith('Basic ')) {
        const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
        const supplied = decoded.slice(decoded.indexOf(':') + 1);
        if (safeEqual(supplied, APP_PASSWORD)) return next();
      }
      res.setHeader('WWW-Authenticate', 'Basic realm="Vacant Lot Finder", charset="UTF-8"');
      res.status(401).send('Password required');
    });
  }

  app.use(express.json({ limit: '5mb' }));

  // API Route: Dallas County municipalities
  app.get('/api/cities', (_req, res) => {
    res.json(DALLAS_COUNTY_CITIES);
  });

  // API Route: Sample streets for instant 1-click testing
  app.get('/api/sample-streets', (_req, res) => {
    res.json([
      { streetName: 'Pennsylvania Ave', city: 'Dallas', zip: '75215', desc: 'Numerous documented vacant residential lots' },
      { streetName: 'Malcolm X Blvd', city: 'Dallas', zip: '75215', desc: 'Residential & mixed lots in South Dallas' },
      { streetName: 'Grand Ave', city: 'Dallas', zip: '75215', desc: 'East Dallas residential corridor' },
      { streetName: 'Garland Ave', city: 'Garland', zip: '75040', desc: 'Garland residential lots' },
      { streetName: 'E 11th St', city: 'Dallas', zip: '75203', desc: 'Oak Cliff residential parcels' },
    ]);
  });

  // API Route: Property detail inspection
  app.get('/api/property/:id', async (req, res) => {
    try {
      const { id } = req.params;
      if (!isValidAccountNumber(id)) {
        return res.status(400).json({ error: 'Invalid DCAD account number' });
      }
      const details = await fetchDCADDetailPage(id);
      res.json(details);
    } catch (err: any) {
      res.status(500).json({ error: err.message || 'Failed to fetch property details' });
    }
  });

  // Unified Search Handler: Step 1 (pull all results, all pages from SearchAddr.aspx, inspect detail page, keep only vacant lots)
  type ProgressData = {
    stage: string;
    message: string;
    percent: number;
    current?: number;
    total?: number;
    lot?: PropertyRecord;
  };

  async function performSearch(
    streetName: string,
    city: string,
    zipFilter?: string,
    maxResults = 0,
    onProgress?: (data: ProgressData) => void,
    isCancelled: () => boolean = () => false
  ): Promise<{ results: PropertyRecord[]; warnings: string[] }> {
    if (!streetName || !streetName.trim()) {
      throw new Error('Street name is required');
    }

    const deadline = SEARCH_TIME_BUDGET_MS > 0 ? Date.now() + SEARCH_TIME_BUDGET_MS : Infinity;
    const cleanStreet = streetName.trim();
    const cleanCity = (city || 'DALLAS').trim();
    // Throws a clear error for a city that is not in Dallas County.
    const { code: cityCode, matchedName, isAll } = findCityCode(cleanCity);
    const gisCity = isAll ? '' : matchedName;
    const warnings: string[] = [];

    // Scan limit: 0 / missing means "no limit" (pull everything).
    const scanCap =
      Number.isFinite(maxResults) && maxResults > 0 ? Math.floor(maxResults) : Infinity;

    onProgress?.({
      stage: 'searching',
      message: `Connecting to DCAD SearchAddr (https://www.dallascad.org/SearchAddr.aspx) for "${cleanStreet}" in ${matchedName}...`,
      percent: 5,
    });

    let records: PropertyRecord[] = [];
    let webError: unknown = null;
    // Accounts whose values were read from DCAD's GIS layer (used if a detail page fails).
    const gisVerified = new Set<string>();

    // Step 1A: Search DCAD Web Portal (SearchAddr.aspx), paginating through ALL result pages
    try {
      const webRecords = await searchDCADWebAddrAllPages(cleanStreet, cityCode, (page, totalPages, count) => {
        const pagePercent = Math.min(35, Math.round((page / Math.max(totalPages, 1)) * 35));
        onProgress?.({
          stage: 'searching',
          message: `Gathering DCAD search results: Page ${page} of ${totalPages} (${count} properties gathered)...`,
          percent: 5 + pagePercent,
          current: page,
          total: totalPages,
        });
      });
      records = webRecords;
    } catch (err) {
      webError = err;
      console.warn('DCAD SearchAddr.aspx pagination search failed, falling back to GIS parcel query:', err);
    }

    if (isCancelled()) return { results: [], warnings };

    // Step 1B: If web scraper returned 0, fallback to DCAD GIS Parcel Server
    if (records.length === 0) {
      onProgress?.({
        stage: 'searching',
        message: 'Querying DCAD Parcel GIS Service (https://maps.dcad.org/prdwa/rest/services)...',
        percent: 25,
      });

      try {
        const gisRecords = await queryDCADParcelServer({
          streetName: cleanStreet,
          city: gisCity,
          limit: Infinity,
        });
        records = gisRecords;
        if (webError) {
          warnings.push(
            "DCAD's address search could not be reached, so these results come from DCAD's GIS parcel layer only."
          );
        }
      } catch (err) {
        console.warn('GIS query fallback failed:', err);
        if (webError) {
          // Both sources failed: this is an outage, not "no vacant lots on this street".
          throw new Error(
            'Could not reach DCAD (both the address search and the GIS parcel service failed). No results were checked. Please try again in a few minutes.'
          );
        }
        warnings.push(
          "DCAD's address search returned no properties and the GIS parcel service could not be reached to double-check."
        );
      }
    } else {
      // If web records found, try to enrich with GIS parcel data (for precise postal zip and geometry)
      try {
        const gisRecords = await queryDCADParcelServer({
          streetName: cleanStreet,
          city: gisCity,
          limit: Infinity,
        });
        const gisMap = new Map<string, PropertyRecord>();
        for (const g of gisRecords) {
          gisMap.set(g.accountNumber, g);
        }
        for (const r of records) {
          const g = gisMap.get(r.accountNumber);
          if (g) {
            gisVerified.add(r.accountNumber);
            if (g.zip) r.zip = g.zip;
            if (g.ownerName) r.ownerName = g.ownerName;
            if (g.aerialImageUrl) r.aerialImageUrl = g.aerialImageUrl;
            if (g.coordinates) r.coordinates = g.coordinates;
            if (g.improvementValue !== undefined) {
              r.improvementValue = g.improvementValue;
              r.improvementValueDisplay = g.improvementValueDisplay;
            }
            if (g.landValue) r.landValue = g.landValue;
            if (g.totalValue) r.totalValue = g.totalValue;
            if (g.propertyClass) r.propertyClass = g.propertyClass;
            if (g.useDescription) r.useDescription = g.useDescription;
            if (g.legalDescription) r.legalDescription = g.legalDescription;
            if (g.buildingArea !== null && g.buildingArea !== undefined) r.buildingArea = g.buildingArea;
            if (g.yearBuilt !== null && g.yearBuilt !== undefined) r.yearBuilt = g.yearBuilt;
            if (g.isLikelyVacant) {
              r.isLikelyVacant = true;
              r.vacantReason = g.vacantReason;
            }
          }
        }
      } catch (err) {
        console.warn('GIS enrichment optional step had error (continuing):', err);
        warnings.push(
          "DCAD's GIS parcel service could not be reached: zip codes, building area and parcel outlines may be missing, and the zip filter cannot exclude lots with no zip on record."
        );
      }
    }

    // User requirement: "if dallas is added on city make sure it searches dallas only"
    if (!isAll) {
      records = records.filter((r) => {
        const c = (r.city || '').trim().toUpperCase();
        if (!c) return true; // DCAD already filtered by city; do not drop rows with a blank city cell
        if (matchedName === 'DALLAS') {
          return c === 'DALLAS';
        }
        return c === matchedName || c.startsWith(matchedName);
      });
    }

    // Apply the scan limit the user picked (it was previously ignored).
    const totalMatched = records.length;
    if (records.length > scanCap) {
      records = records.slice(0, scanCap);
      warnings.push(
        `Scan limit reached: inspected the first ${scanCap} of ${totalMatched} properties on this street. Raise the scan limit (or choose "No limit") to cover the rest.`
      );
    }

    const vacantOnlyRecords = await inspectAndPrescreen(
      records,
      gisVerified,
      warnings,
      deadline,
      {
        zipFilter,
        foundLabel: 'residential properties across all pages',
        scope: ' on this street',
        timeLimitAdvice:
          'The list below is incomplete - search this street with a direction or street type to narrow it, or raise the plan\'s time limit.',
      },
      onProgress,
      isCancelled
    );
    return { results: vacantOnlyRecords, warnings };
  }

  /**
   * Steps 1C and 2, shared by the street search and the address import: read each
   * property's DCAD detail page, keep the vacant candidates, then run the records pre-screen.
   */
  async function inspectAndPrescreen(
    records: PropertyRecord[],
    gisVerified: Set<string>,
    warnings: string[],
    deadline: number,
    ctx: { zipFilter?: string; foundLabel: string; scope: string; timeLimitAdvice: string },
    onProgress?: (data: ProgressData) => void,
    isCancelled: () => boolean = () => false
  ): Promise<PropertyRecord[]> {
    onProgress?.({
      stage: 'inspecting',
      message: `Found ${records.length} ${ctx.foundLabel}. Inspecting detail pages for $0 improvement value & vacant lots...`,
      percent: 40,
      total: records.length,
      current: 0,
    });

    // Step 1C: For each property found, inspect its DCAD detail page & verify vacant criteria
    const vacantOnlyRecords: PropertyRecord[] = [];
    const totalToInspect = records.length;
    let unverifiedCount = 0;
    const cleanZipFilter = (ctx.zipFilter || '').trim();

    for (let i = 0; i < totalToInspect; i++) {
      // Stop hitting DCAD as soon as the user cancels / closes the page.
      if (isCancelled()) return vacantOnlyRecords;

      // Hosted platforms cut a request off after a few minutes. Finish cleanly with what
      // we have, and say so, instead of being cut off with nothing.
      if (Date.now() > deadline) {
        warnings.push(
          `Time limit reached: inspected ${i} of ${totalToInspect} properties${ctx.scope} before the server's time limit. ${ctx.timeLimitAdvice}`
        );
        break;
      }

      const record = records[i];
      const currentNum = i + 1;
      const progressPercent = 40 + Math.round((currentNum / Math.max(totalToInspect, 1)) * 45);

      try {
        // Values are trustworthy only if they came from the GIS layer or a parsed detail page.
        let verified = record.source === 'dcad_gis' || gisVerified.has(record.accountNumber);

        if (record.source === 'dcad_search') {
          let detail: Awaited<ReturnType<typeof fetchDCADDetailPage>> | null = null;
          try {
            detail = await fetchDCADDetailPage(record.accountNumber);
          } catch (err) {
            console.warn(`Detail page fetch failed for ${record.accountNumber}:`, err);
          }

          if (detail && detail.parsed) {
            verified = true;
            if (detail.impVal !== null) {
              record.improvementValue = detail.impVal;
            }
            if (detail.isNAImp) {
              record.improvementValue = 0;
              record.improvementValueDisplay = 'N/A';
            } else if (detail.impDisplay) {
              record.improvementValueDisplay = detail.impDisplay;
            }
            if (detail.landVal !== null) {
              record.landValue = detail.landVal;
            }
            if (detail.totalVal !== null) {
              record.totalValue = detail.totalVal;
            }
            if (detail.ownerName && !record.ownerName) {
              record.ownerName = detail.ownerName;
            }
            if (detail.isVacant) {
              record.isLikelyVacant = true;
              record.vacantReason = detail.vacantReason || 'N/A or $0 improvement value';
            }
          }

          // Small delay to prevent rate-limiting on DCAD
          await new Promise((r) => setTimeout(r, 40));
        }

        if (!verified) {
          // We could not read this property's values. Do NOT assume $0 = vacant.
          unverifiedCount++;
          onProgress?.({
            stage: 'inspecting',
            message: `Could not read DCAD values for ${record.address} (${currentNum}/${totalToInspect}) - skipped, not counted as vacant.`,
            percent: progressPercent,
            current: currentNum,
            total: totalToInspect,
          });
          continue;
        }

        // Apply zip code filter if specified by user (using the zip shown on property).
        // Lots with no zip on record are kept so they are never silently lost.
        if (cleanZipFilter && record.zip && !record.zip.startsWith(cleanZipFilter)) {
          continue; // Filtered out by user's zip filter
        }

        // Step 1 requirement: Keep vacant lots based on DCAD's data (including $0 and N/A improvement values)
        const isImpZero = record.improvementValue === 0;
        const isImpNA = record.improvementValueDisplay === 'N/A' || isNaN(record.improvementValue);
        const isClassVacant = (record.propertyClass || '').toUpperCase().includes('VACANT');
        const isUseVacant = (record.useDescription || '').toUpperCase().includes('VACANT');
        const isVacant = isImpZero || isImpNA || isClassVacant || isUseVacant;

        if (isVacant) {
          if (isNaN(record.improvementValue)) {
            record.improvementValue = 0;
            record.improvementValueDisplay = 'N/A';
          }
          record.isLikelyVacant = true;
          record.mapCheck = 'Pending MapCheck';
          if (!record.vacantReason) {
            record.vacantReason = isImpNA
              ? 'N/A improvement value (no structures assessed)'
              : (isImpZero
                  ? '$0 improvement value (no structures assessed)'
                  : `Classified as ${record.propertyClass}`);
          }
          vacantOnlyRecords.push(record);

          const impLabel =
            record.improvementValueDisplay === 'N/A'
              ? 'N/A'
              : `$${record.improvementValue.toLocaleString()}`;
          onProgress?.({
            stage: 'inspecting',
            message: `[CANDIDATE VACANT LOT] ${record.address} (${impLabel} Improvement, Land: $${record.landValue.toLocaleString()})`,
            percent: progressPercent,
            current: currentNum,
            total: totalToInspect,
            lot: record,
          });
        } else {
          onProgress?.({
            stage: 'inspecting',
            message: `Inspecting ${record.address} (${currentNum}/${totalToInspect}) - Improved ($${record.improvementValue.toLocaleString()}), skipping...`,
            percent: progressPercent,
            current: currentNum,
            total: totalToInspect,
          });
        }
      } catch (err) {
        unverifiedCount++;
        console.warn(`Error inspecting property ${record.accountNumber}:`, err);
      }
    }

    if (unverifiedCount > 0) {
      warnings.push(
        `${unverifiedCount} of ${totalToInspect} properties could not be checked because DCAD did not return readable values for them. They are NOT in the results below - run the search again to retry them.`
      );
    }

    // Step 2: DCAD records pre-screen (flags lots whose records show a building).
    // This does not review aerial imagery; lots stay "Pending MapCheck" until a person confirms.
    if (vacantOnlyRecords.length > 0) {
      onProgress?.({
        stage: 'inspecting',
        message: `Step 2: Running DCAD records pre-screen on ${vacantOnlyRecords.length} candidate vacant lots...`,
        percent: 88,
        total: vacantOnlyRecords.length,
      });

      for (let j = 0; j < vacantOnlyRecords.length; j++) {
        if (isCancelled()) return vacantOnlyRecords;
        const lot = vacantOnlyRecords[j];
        try {
          const autoRes = await runAutoMapCheck(lot);
          lot.mapCheck = autoRes.mapCheck;
          lot.mapCheckExplanation = autoRes.explanation;
          lot.autoChecked = true;

          onProgress?.({
            stage: 'inspecting',
            message: `[Pre-screen done] ${lot.address} -> ${lot.mapCheck}`,
            percent: 88 + Math.round(((j + 1) / vacantOnlyRecords.length) * 11),
            current: j + 1,
            total: vacantOnlyRecords.length,
            lot,
          });
        } catch (err) {
          console.warn(`Error running records pre-screen on ${lot.accountNumber}:`, err);
        }
      }
    }

    onProgress?.({
      stage: 'completed',
      message: `Complete: ${vacantOnlyRecords.length} candidate vacant lots found. Confirm each on the aerial map.`,
      percent: 100,
      total: vacantOnlyRecords.length,
    });

    return vacantOnlyRecords;
  }


  // Address import: look up specific addresses (or DCAD account numbers) and run them through
  // exactly the same checks as a street search (detail page, vacant criteria, records
  // pre-screen, aerial imagery). Addresses that are not vacant candidates are listed in the
  // summary instead of the results table.
  const MAX_IMPORT_ADDRESSES = 500;

  async function performImport(
    rawAddresses: unknown,
    defaultCity: string,
    onProgress?: (data: ProgressData) => void,
    isCancelled: () => boolean = () => false
  ): Promise<{ results: PropertyRecord[]; warnings: string[]; summary: ImportSummary }> {
    const lines: string[] = (
      Array.isArray(rawAddresses) ? rawAddresses : String(rawAddresses || '').split(/\r?\n/)
    )
      .map((l) => String(l ?? '').trim())
      .filter(Boolean);
    const uniqueLines = [...new Set(lines)];
    if (uniqueLines.length === 0) {
      throw new Error('No addresses were provided. Paste one address per line or upload a file.');
    }

    const warnings: string[] = [];
    const deadline = SEARCH_TIME_BUDGET_MS > 0 ? Date.now() + SEARCH_TIME_BUDGET_MS : Infinity;

    // Optional default city for lines that do not name one (a preference, never a hard filter).
    const cityInput = (defaultCity || '').trim();
    const { matchedName, isAll } = findCityCode(cityInput || 'ALL DALLAS COUNTY');
    const fallbackCity = isAll ? undefined : matchedName;

    let toLookUp = uniqueLines;
    if (uniqueLines.length > MAX_IMPORT_ADDRESSES) {
      toLookUp = uniqueLines.slice(0, MAX_IMPORT_ADDRESSES);
      warnings.push(
        `Only the first ${MAX_IMPORT_ADDRESSES} of ${uniqueLines.length} addresses were processed. Import the rest in a second batch.`
      );
    }

    const summary: ImportSummary = {
      requested: toLookUp.length,
      matched: 0,
      notFound: [],
      notVacant: [],
    };

    onProgress?.({
      stage: 'searching',
      message: `Matching ${toLookUp.length} imported address${toLookUp.length === 1 ? '' : 'es'} to DCAD parcels...`,
      percent: 5,
    });

    // Step 1A: resolve every line to a DCAD parcel (a few lookups at a time).
    const matchedByInput = new Map<string, PropertyRecord[]>();
    const gisErrors: string[] = [];
    let done = 0;
    let cursor = 0;
    const worker = async () => {
      while (cursor < toLookUp.length) {
        if (isCancelled() || Date.now() > deadline) return;
        const line = toLookUp[cursor++];
        const parsed: ParsedAddress | null = parseAddressLine(line);
        try {
          if (!parsed || (!parsed.accountNumber && !(parsed.houseNumber && parsed.street))) {
            summary.notFound.push({
              input: line,
              reason: 'Could not read a house number and street name from this line.',
            });
          } else {
            if (!parsed.city && fallbackCity) parsed.city = fallbackCity;
            const found = await lookupParcelsForAddress(parsed);
            if (found.length === 0) {
              summary.notFound.push({ input: line, reason: 'No matching parcel found in DCAD records.' });
            } else {
              matchedByInput.set(line, found);
            }
          }
        } catch (err: any) {
          gisErrors.push(err?.message || 'lookup failed');
          summary.notFound.push({ input: line, reason: 'DCAD could not be reached for this address - try again.' });
        }
        done++;
        onProgress?.({
          stage: 'searching',
          message: `Matching addresses to DCAD parcels: ${done} of ${toLookUp.length}...`,
          percent: 5 + Math.round((done / toLookUp.length) * 33),
          current: done,
          total: toLookUp.length,
        });
      }
    };
    await Promise.all(Array.from({ length: Math.min(4, toLookUp.length) }, () => worker()));

    if (isCancelled()) return { results: [], warnings, summary };
    if (done < toLookUp.length) {
      warnings.push(
        `Time limit reached: matched ${done} of ${toLookUp.length} addresses before the server's time limit. Import the remaining addresses in a second batch.`
      );
    }
    if (gisErrors.length > 0 && matchedByInput.size === 0) {
      throw new Error(
        "Could not reach DCAD's parcel service, so none of the addresses could be matched. Please try again in a few minutes."
      );
    }
    if (gisErrors.length > 0) {
      warnings.push(
        `${gisErrors.length} address${gisErrors.length === 1 ? '' : 'es'} could not be looked up because DCAD's parcel service did not respond. They are listed under "not found" - import them again to retry.`
      );
    }

    // Collect unique parcels, remembering which line each came from.
    const records: PropertyRecord[] = [];
    const inputForAccount = new Map<string, string>();
    for (const [line, found] of matchedByInput) {
      for (const rec of found) {
        if (!rec.accountNumber || inputForAccount.has(rec.accountNumber)) continue;
        inputForAccount.set(rec.accountNumber, line);
        records.push(rec);
      }
    }
    summary.matched = records.length;

    // Values already came from DCAD's GIS layer (same as a street search's enrichment step);
    // marking them 'dcad_search' makes the detail-page check run on them too, so imported
    // addresses are verified exactly like street results.
    const gisVerified = new Set<string>();
    for (const rec of records) {
      gisVerified.add(rec.accountNumber);
      rec.source = 'dcad_search';
    }

    const vacantOnlyRecords = await inspectAndPrescreen(
      records,
      gisVerified,
      warnings,
      deadline,
      {
        foundLabel: 'matching properties',
        scope: ' in this import',
        timeLimitAdvice: 'The list below is incomplete - import the remaining addresses in a second batch.',
      },
      onProgress,
      isCancelled
    );

    // Explain every matched address that did not become a candidate vacant lot.
    const keptAccounts = new Set(vacantOnlyRecords.map((r) => r.accountNumber));
    for (const rec of records) {
      if (keptAccounts.has(rec.accountNumber)) continue;
      const imp = rec.improvementValue > 0 ? `$${rec.improvementValue.toLocaleString()}` : null;
      summary.notVacant.push({
        input: inputForAccount.get(rec.accountNumber) || rec.address,
        address: rec.address,
        accountNumber: rec.accountNumber,
        dcadLink: rec.dcadLink,
        reason: imp
          ? `Has improvements on DCAD records (${imp} improvement value) - not a vacant candidate.`
          : 'Not reported as a vacant candidate (or DCAD values could not be read).',
      });
    }

    return { results: vacantOnlyRecords, warnings, summary };
  }

  // API Route: DCAD Map Viewer automatically locked to 2026 Hybrid basemap
  app.get('/api/dcad-map', async (req, res) => {
    const parcelId = req.query.parcelid ? String(req.query.parcelid) : '';
    if (!isValidAccountNumber(parcelId)) {
      return res.status(400).send('Invalid or missing parcelid');
    }
    try {
      const dcadUrl = officialMapUrl(parcelId);
      const response = await fetchWithTimeout(dcadUrl, {
        headers: {
          'User-Agent': DCAD_USER_AGENT,
        },
      });
      if (!response.ok) {
        throw new Error(`DCAD map viewer HTTP ${response.status}`);
      }
      let html = await response.text();

      // Inject base href and auto-switch script for 2026 Hybrid
      const auto2026Script = `
        <base href="https://maps.dcad.org/prd/dpm/">
        <script>
          // Automatic 2026 Hybrid Basemap Selection
          (function() {
            function activate2026() {
              var thumb = document.getElementById("imgThumbNailimagery${IMAGERY_YEAR}Map");
              if (thumb) {
                if (typeof ChangeBaseMap === "function") {
                  try {
                    ChangeBaseMap(thumb);
                    console.log("[DCAD 2026 Auto] Successfully activated 2026 Hybrid via ChangeBaseMap!");
                    return true;
                  } catch (e) {}
                }
                try {
                  thumb.click();
                  console.log("[DCAD 2026 Auto] Successfully activated 2026 Hybrid via click!");
                  return true;
                } catch (e) {}
              }
              return false;
            }

            var tries = 0;
            var timer = setInterval(function() {
              tries++;
              if (activate2026() || tries > 60) {
                clearInterval(timer);
              }
            }, 200);

            window.addEventListener("load", function() {
              setTimeout(activate2026, 600);
              setTimeout(activate2026, 1800);
            });
          })();
        </script>
      `;

      // Case-insensitive and tolerant of attributes on <head>; a function replacement
      // avoids "$" sequences in the injected script being treated as patterns.
      if (/<head[^>]*>/i.test(html)) {
        html = html.replace(/<head[^>]*>/i, (m) => `${m}\n${auto2026Script}`);
      } else {
        html = auto2026Script + html;
      }
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.send(html);
    } catch (err: any) {
      console.error('Error proxying DCAD map:', err);
      res.redirect(officialMapUrl(parcelId));
    }
  });

  // API Route: DCAD 2026 Official Aerial Photography Proxy
  app.get('/api/dcad-aerial-2026', async (req, res) => {
    const bbox = parseBbox(req.query.bbox ? String(req.query.bbox) : '');
    const size = parseSize(req.query.size ? String(req.query.size) : '900,600');
    if (!bbox) {
      return res.status(400).send('Missing or invalid bbox query parameter');
    }
    try {
      // Official DCAD Aerial Photography endpoint via DCAD's proxy.ashx
      const dcad2026Url = `https://maps.dcad.org/DotNet/proxy.ashx?https://maps.dcad.org/prdwa/rest/services/Imagery/Imagery${IMAGERY_YEAR}/MapServer/export?bbox=${encodeURIComponent(bbox)}&bboxSR=3857&imageSR=3857&size=${encodeURIComponent(size)}&f=image`;
      const imgRes = await fetchWithTimeout(dcad2026Url, {
        headers: {
          'User-Agent': DCAD_USER_AGENT,
          'Referer': 'https://maps.dcad.org/prd/dpm/',
        },
      });
      if (!imgRes.ok) {
        throw new Error(`DCAD Imagery${IMAGERY_YEAR} HTTP ${imgRes.status}`);
      }
      const contentType = imgRes.headers.get('content-type') || 'image/png';
      // ArcGIS reports errors as JSON with HTTP 200; do not hand that to an <img>.
      if (!contentType.toLowerCase().startsWith('image/')) {
        throw new Error(`DCAD Imagery${IMAGERY_YEAR} returned ${contentType} instead of an image`);
      }
      res.setHeader('Content-Type', contentType);
      res.setHeader('X-Imagery-Source', `DCAD ${IMAGERY_YEAR}`);
      res.setHeader('Cache-Control', 'public, max-age=86400');
      const arrayBuffer = await imgRes.arrayBuffer();
      return res.send(Buffer.from(arrayBuffer));
    } catch (err: any) {
      console.warn('Error fetching 2026 DCAD aerial, using fallback:', err.message);
      try {
        const fallbackUrl = `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/export?bbox=${encodeURIComponent(bbox)}&bboxSR=3857&imageSR=3857&size=${encodeURIComponent(size)}&f=image`;
        const fbRes = await fetchWithTimeout(fallbackUrl);
        if (fbRes.ok && (fbRes.headers.get('content-type') || '').toLowerCase().startsWith('image/')) {
          res.setHeader('Content-Type', fbRes.headers.get('content-type') || 'image/jpeg');
          // Not DCAD's current-year flight: undated Esri World Imagery, can be years old.
          res.setHeader('X-Imagery-Source', 'Esri World Imagery (fallback, date unknown)');
          const buf = await fbRes.arrayBuffer();
          return res.send(Buffer.from(buf));
        }
      } catch (_fbErr) {}
      return res.status(500).send('Unable to load aerial photography');
    }
  });

  // API Route: DCAD Parcel Line Overlay Proxy
  app.get('/api/dcad-parcel-overlay', async (req, res) => {
    const bbox = parseBbox(req.query.bbox ? String(req.query.bbox) : '');
    const size = parseSize(req.query.size ? String(req.query.size) : '900,600');
    if (!bbox) {
      return res.status(400).send('Missing or invalid bbox query parameter');
    }
    try {
      const overlayUrl = `https://maps.dcad.org/prdwa/rest/services/Property/ImageryParcel/MapServer/export?bbox=${encodeURIComponent(bbox)}&bboxSR=3857&imageSR=3857&size=${encodeURIComponent(size)}&transparent=true&f=image`;
      const imgRes = await fetchWithTimeout(overlayUrl, {
        headers: {
          'User-Agent': DCAD_USER_AGENT,
          'Referer': 'https://maps.dcad.org/prd/dpm/',
        },
      });
      if (!imgRes.ok || !(imgRes.headers.get('content-type') || '').toLowerCase().startsWith('image/')) {
        throw new Error(`ImageryParcel HTTP ${imgRes.status}`);
      }
      res.setHeader('Content-Type', imgRes.headers.get('content-type') || 'image/png');
      res.setHeader('Cache-Control', 'public, max-age=86400');
      const arrayBuffer = await imgRes.arrayBuffer();
      return res.send(Buffer.from(arrayBuffer));
    } catch (err: any) {
      console.warn('Error fetching parcel overlay:', err.message);
      // Return 1x1 transparent PNG on error so img doesn't break
      const transparentPng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');
      res.setHeader('Content-Type', 'image/png');
      return res.send(transparentPng);
    }
  });

  // API Route: Fetch 2026 Hybrid Map screenshot data & parcel geometry
  app.get('/api/parcel-snapshot/:accountNumber', async (req, res) => {
    const accountNumber = req.params.accountNumber;
    const address = req.query.address ? String(req.query.address) : undefined;
    if (!isValidAccountNumber(accountNumber)) {
      return res.status(400).json({ success: false, error: 'Invalid DCAD account number' });
    }
    try {
      const snapshot = await fetchParcelSnapshot(accountNumber, address);
      if (!snapshot) {
        return res.status(404).json({
          success: false,
          error: 'DCAD has no parcel boundary on file for this account, so an aerial snapshot cannot be drawn.',
        });
      }
      return res.json({ success: true, snapshot });
    } catch (err: any) {
      console.error(`Error in /api/parcel-snapshot/${accountNumber}:`, err);
      return res.status(500).json({ success: false, error: err.message });
    }
  });

  // API Route: Run the DCAD records pre-screen on demand (does not review imagery)
  app.post('/api/auto-mapcheck', async (req, res) => {
    try {
      const { lots } = req.body;
      if (!Array.isArray(lots)) {
        return res.status(400).json({ error: 'lots must be an array of property records' });
      }

      const results = [];
      for (const lot of lots) {
        const check = await runAutoMapCheck(lot);
        results.push({
          accountNumber: lot.accountNumber,
          mapCheck: check.mapCheck,
          explanation: check.explanation,
          confidence: check.confidence,
        });
      }

      res.json({ success: true, count: results.length, results });
    } catch (err: any) {
      res.status(500).json({ error: err.message || 'Auto MapCheck failed' });
    }
  });

  // API Route: Standard JSON Search
  app.post('/api/search', async (req, res) => {
    try {
      const { streetName, city, zipFilter, maxResults } = req.body || {};
      const { results, warnings } = await performSearch(
        streetName,
        city,
        zipFilter,
        Number(maxResults) || 0
      );
      res.json({ success: true, count: results.length, results, warnings });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message || 'Search failed' });
    }
  });

  // API Route: Address import (JSON, no live progress)
  app.post('/api/import', async (req, res) => {
    try {
      const { addresses, city } = req.body || {};
      const { results, warnings, summary } = await performImport(addresses, city);
      res.json({ success: true, count: results.length, results, warnings, summary });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message || 'Import failed' });
    }
  });

  // API Route: Address import with live progress (server-sent events over POST, because a
  // pasted list is too long for a URL). Same events as /api/search/stream plus an import summary.
  app.post('/api/import/stream', async (req, res) => {
    const { addresses, city } = req.body || {};

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();

    // Stop querying DCAD as soon as the browser aborts the request (Stop button, new search).
    let cancelled = false;
    res.on('close', () => {
      if (!res.writableEnded) cancelled = true;
    });

    const sendEvent = (event: string, data: any) => {
      if (cancelled || res.writableEnded) return;
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    try {
      const { results, warnings, summary } = await performImport(
        addresses,
        city,
        (progress) => {
          sendEvent('progress', progress);
          if (progress.lot) sendEvent('lot_found', progress.lot);
        },
        () => cancelled
      );
      if (cancelled) return;
      sendEvent('done', { results, warnings, summary, vacantLots: results.filter((r) => r.isLikelyVacant) });
      res.end();
    } catch (err: any) {
      sendEvent('search_error', { error: err.message || 'Import failed' });
      if (!res.writableEnded) res.end();
    }
  });

  // API Route: SSE Streaming Search for Real-Time Progress
  app.get('/api/search/stream', async (req, res) => {
    const streetName = (req.query.streetName as string) || '';
    const city = (req.query.city as string) || 'Dallas';
    const zipFilter = (req.query.zipFilter as string) || '';
    const maxResults = parseInt((req.query.maxResults as string) || '0', 10) || 0;

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();

    // When the browser closes the stream (Stop button, new search, tab closed) stop
    // scraping DCAD instead of running the whole search to completion in the background.
    let cancelled = false;
    res.on('close', () => {
      if (!res.writableEnded) cancelled = true;
    });

    const sendEvent = (event: string, data: any) => {
      if (cancelled || res.writableEnded) return;
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    try {
      const { results, warnings } = await performSearch(
        streetName,
        city,
        zipFilter,
        maxResults,
        (progress) => {
          sendEvent('progress', progress);
          if (progress.lot) {
            sendEvent('lot_found', progress.lot);
          }
        },
        () => cancelled
      );

      if (cancelled) return;
      sendEvent('done', {
        results,
        warnings,
        vacantLots: results.filter(r => r.isLikelyVacant),
      });
      res.end();
    } catch (err: any) {
      // Named "search_error" (not "error") so the browser can tell a real search failure
      // apart from a dropped connection, which EventSource also reports as "error".
      sendEvent('search_error', { error: err.message || 'Search execution failed' });
      if (!res.writableEnded) res.end();
    }
  });

  return app;
}

const app = createApp();
export default app;
