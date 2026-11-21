import type { CityOption, PropertyRecord } from '../src/types/property.js';

export const DALLAS_COUNTY_CITIES: CityOption[] = [
  { code: '', name: 'ALL DALLAS COUNTY' },
  { code: '12', name: 'DALLAS' },
  { code: '20', name: 'GARLAND' },
  { code: '31', name: 'IRVING' },
  { code: '34', name: 'MESQUITE' },
  { code: '24', name: 'GRAND PRAIRIE' },
  { code: '39', name: 'RICHARDSON' },
  { code: '3', name: 'CARROLLTON' },
  { code: '40', name: 'ROWLETT' },
  { code: '15', name: 'DESOTO' },
  { code: '6', name: 'CEDAR HILL' },
  { code: '32', name: 'LANCASTER' },
  { code: '17', name: 'FARMERS BRANCH' },
  { code: '10', name: 'COPPELL' },
  { code: '16', name: 'DUNCANVILLE' },
  { code: '1', name: 'ADDISON' },
  { code: '2', name: 'BALCH SPRINGS' },
  { code: '43', name: 'SEAGOVILLE' },
  { code: '42', name: 'SACHSE' },
  { code: '46', name: 'UNIVERSITY PARK' },
  { code: '29', name: 'HIGHLAND PARK' },
  { code: '22', name: 'GLENN HEIGHTS' },
  { code: '30', name: 'HUTCHINS' },
  { code: '45', name: 'SUNNYVALE' },
  { code: '48', name: 'WILMER' },
  { code: '7', name: 'COCKRELL HILL' },
  { code: '9', name: 'COMBINE' },
  { code: '18', name: 'FERRIS' },
  { code: '28', name: 'GRAPEVINE' },
  { code: '33', name: 'LEWISVILLE' },
  { code: '38', name: 'OVILLA' },
  { code: '49', name: 'WYLIE' },
];

export const DCAD_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

/** Aerial/overlay images are always requested at this size (3:2). */
export const SNAPSHOT_WIDTH = 900;
export const SNAPSHOT_HEIGHT = 600;

/** fetch() with a hard timeout so one stalled DCAD request cannot hang a whole search. */
export function fetchWithTimeout(url: string, init: RequestInit = {}, timeoutMs = 20000): Promise<Response> {
  return fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
}

/** Escape a value for use inside a single-quoted ArcGIS SQL string. */
function sqlEscape(value: string): string {
  return value.replace(/'/g, "''");
}

/** True when the city input means "search the whole county". */
export function isAllCities(cityName: string | undefined | null): boolean {
  const normalized = (cityName || '').trim().toUpperCase();
  return !normalized || normalized === 'ALL' || normalized === 'DALLAS COUNTY' || normalized === 'ALL DALLAS COUNTY';
}

/** Public DCAD map URL for a parcel (safe to share / export; not routed through this app). */
export function officialMapUrl(accountNumber: string): string {
  return `https://maps.dcad.org/prd/dpm/?parcelid=${encodeURIComponent(accountNumber)}`;
}

/**
 * Expand a bounding box so it has the same aspect ratio as the image we request.
 * ArcGIS silently grows the extent to fit the image; doing it ourselves keeps the
 * parcel outline we draw lined up with the aerial photo.
 */
export function fitBboxToAspect(
  minX: number,
  minY: number,
  maxX: number,
  maxY: number,
  aspect = SNAPSHOT_WIDTH / SNAPSHOT_HEIGHT
): { minX: number; minY: number; maxX: number; maxY: number } {
  const width = maxX - minX;
  const height = maxY - minY;
  if (!(width > 0) || !(height > 0)) return { minX, minY, maxX, maxY };
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  if (width / height < aspect) {
    const newWidth = height * aspect;
    return { minX: cx - newWidth / 2, minY, maxX: cx + newWidth / 2, maxY };
  }
  const newHeight = width / aspect;
  return { minX, minY: cy - newHeight / 2, maxX, maxY: cy + newHeight / 2 };
}

const SUFFIX_CANON: Record<string, string> = {
  AVENUE: 'AVE', AVE: 'AVE', STREET: 'ST', ST: 'ST', ROAD: 'RD', RD: 'RD',
  BOULEVARD: 'BLVD', BLVD: 'BLVD', DRIVE: 'DR', DR: 'DR', LANE: 'LN', LN: 'LN',
  COURT: 'CT', CT: 'CT', WAY: 'WAY', TERRACE: 'TER', TER: 'TER', PLACE: 'PL', PL: 'PL',
  PARKWAY: 'PKWY', PKWY: 'PKWY', CIRCLE: 'CIR', CIR: 'CIR', TRAIL: 'TRL', TRL: 'TRL',
  HIGHWAY: 'HWY', HWY: 'HWY', EXPRESSWAY: 'EXPY', EXPY: 'EXPY',
};
const DIRECTION_PREFIXES = new Set(['N', 'S', 'E', 'W', 'NE', 'NW', 'SE', 'SW']);

export interface ParsedStreet {
  /** Core street name sent to DCAD (no direction prefix, no street type). */
  rootName: string;
  cleanFullName: string;
  /** Direction prefix the user typed (e.g. "E" in "E 11th St"), or ''. */
  direction: string;
  /** Canonical street type the user typed (e.g. "AVE"), or ''. */
  suffix: string;
}

export function normalizeStreetName(rawStreet: string): ParsedStreet {
  const cleaned = rawStreet.trim().toUpperCase().replace(/[.,]/g, ' ').replace(/\s+/g, ' ').trim();
  const tokens = cleaned.split(' ').filter(Boolean);

  // Street type at the end ("AVE", "BLVD"...). Only strip when something is left over.
  let suffix = '';
  if (tokens.length >= 2 && SUFFIX_CANON[tokens[tokens.length - 1]]) {
    suffix = SUFFIX_CANON[tokens.pop() as string];
  }

  // Abbreviated direction prefix ("E 11TH"). DCAD's street-name box does not accept it.
  let direction = '';
  if (tokens.length >= 2 && DIRECTION_PREFIXES.has(tokens[0])) {
    direction = tokens.shift() as string;
  }

  return {
    rootName: tokens.join(' ') || cleaned,
    cleanFullName: cleaned,
    direction,
    suffix,
  };
}

/**
 * Narrow search results to the street the user actually typed.
 * DCAD and the GIS layer both match loosely (searching "ELM" also returns "ELMWOOD",
 * "GRAND AVE" also returns "GRAND ST"). Each narrowing step is skipped if it would
 * remove every record, so an unexpected address format never silently empties a search.
 */
export function filterToStreet<T extends { address: string }>(records: T[], street: ParsedStreet): T[] {
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const root = esc(street.rootName);

  const rootRe = new RegExp(`(^|\\s)${root}(\\s|$)`);
  let out = records.filter((r) => rootRe.test((r.address || '').toUpperCase()));
  if (out.length === 0) return records;

  if (street.suffix) {
    const nextTokenRe = new RegExp(`(^|\\s)${root}\\s+(\\S+)`);
    const withSuffix = out.filter((r) => {
      const next = (r.address || '').toUpperCase().match(nextTokenRe)?.[2] || '';
      return SUFFIX_CANON[next] === street.suffix;
    });
    if (withSuffix.length > 0) out = withSuffix;
  }

  if (street.direction) {
    const dirRe = new RegExp(`(^|\\s)${esc(street.direction)}\\s+${root}(\\s|$)`);
    const withDirection = out.filter((r) => dirRe.test((r.address || '').toUpperCase()));
    if (withDirection.length > 0) out = withDirection;
  }

  return out;
}

export function findCityCode(cityName: string): { code: string; matchedName: string; isAll: boolean } {
  const normalized = cityName.trim().toUpperCase();
  if (isAllCities(normalized)) {
    return { code: '', matchedName: 'ALL DALLAS COUNTY', isAll: true };
  }
  const cities = DALLAS_COUNTY_CITIES.filter((c) => c.code !== '');
  const match =
    cities.find((c) => c.name === normalized) ||
    cities.find((c) => c.name.startsWith(normalized)) ||
    cities.find((c) => normalized.includes(c.name));
  if (match) {
    return { code: match.code, matchedName: match.name, isAll: false };
  }
  // Previously an unknown city silently searched Dallas and then filtered every result away.
  throw new Error(
    `City "${cityName.trim()}" is not a recognized Dallas County city. Pick one from the list or use "ALL DALLAS COUNTY".`
  );
}

/** Turn one DCAD ParcelQuery feature into a PropertyRecord (shared by street and address lookups). */
export function gisFeatureToRecord(f: any): PropertyRecord {
  const attrs = f.attributes || {};
  const parcelIdVal = (attrs.PARCELID || '').trim();
  const addressVal = (attrs.SITEADDRESS || '').trim();
  const cityVal = (attrs.PSTLCITY || '').trim();

  const zipVal = (attrs.PSTLZIP5 || '').trim();

  // Parse improvement value - handle N/A, null, empty, or 0
  let impVal = 0;
  let isImpNA = false;
  const rawImp = attrs.IMPVALUE;
  if (rawImp === null || rawImp === undefined) {
    impVal = 0;
    isImpNA = true;
  } else if (typeof rawImp === 'string' && (
    rawImp.trim().toUpperCase() === 'N/A' ||
    rawImp.trim() === '' ||
    rawImp.trim() === '--' ||
    rawImp.trim().toUpperCase().includes('N/A') ||
    rawImp.trim().toUpperCase() === 'NONE'
  )) {
    impVal = 0;
    isImpNA = true;
  } else {
    const parsed = Number(rawImp);
    if (isNaN(parsed)) {
      impVal = 0;
      isImpNA = true;
    } else {
      impVal = parsed;
    }
  }

  const lndVal = Number(attrs.LNDVALUE ?? 0);
  const totalVal = Number(attrs.CNTASSDVAL ?? (impVal + lndVal));
  const classVal = (attrs.CLASSDSCRP || '').trim();
  const useVal = (attrs.USEDSCRP || '').trim();
  const yearBuilt = attrs.RESYRBLT ? Number(attrs.RESYRBLT) : null;
  const bldgArea = attrs.BLDGAREA ? Number(attrs.BLDGAREA) : null;

  // Check if lot is vacant (include $0 and N/A improvement values)
  const isImpZero = impVal === 0 || isImpNA;
  const isClassVacant = classVal.toUpperCase().includes('VACANT');
  const isUseVacant = useVal.toUpperCase().includes('VACANT');
  const isLikelyVacant = isImpZero || isClassVacant || isUseVacant;

  let vacantReason = '';
  if (isImpNA && isClassVacant) {
    vacantReason = `N/A improvement value & classified as "${classVal}"`;
  } else if (isImpNA) {
    vacantReason = 'N/A improvement value (no structures assessed)';
  } else if (isImpZero && isClassVacant) {
    vacantReason = `$0 improvement value & classified as "${classVal}"`;
  } else if (isImpZero) {
    vacantReason = '$0 improvement value (no structures assessed)';
  } else if (isClassVacant) {
    vacantReason = `Classified as "${classVal}"`;
  }

  let aerialImageUrl: string | undefined;
  let coordinates: { x: number; y: number } | null = null;
  if (f.geometry && Array.isArray(f.geometry.rings) && f.geometry.rings.length > 0) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const ring of f.geometry.rings) {
      for (const pt of ring) {
        if (pt[0] < minX) minX = pt[0];
        if (pt[0] > maxX) maxX = pt[0];
        if (pt[1] < minY) minY = pt[1];
        if (pt[1] > maxY) maxY = pt[1];
      }
    }
    if (isFinite(minX) && isFinite(minY)) {
      const padX = Math.max((maxX - minX) * 0.45, 35);
      const padY = Math.max((maxY - minY) * 0.45, 35);
      const b = fitBboxToAspect(minX - padX, minY - padY, maxX + padX, maxY + padY);
      const bbox = `${b.minX},${b.minY},${b.maxX},${b.maxY}`;
      // Official DCAD Aerial Photography
      aerialImageUrl = `/api/dcad-aerial-2026?bbox=${encodeURIComponent(bbox)}&size=${SNAPSHOT_WIDTH},${SNAPSHOT_HEIGHT}`;
      coordinates = { x: (minX + maxX) / 2, y: (minY + maxY) / 2 };
    }
  }

  const ownerNameVal = (attrs.OWNERNME1 || attrs.CNVYNAME || '').trim();

  return {
    accountNumber: parcelIdVal,
    address: addressVal,
    city: cityVal,
    zip: zipVal,
    ownerName: ownerNameVal || undefined,
    improvementValue: impVal,
    improvementValueDisplay: isImpNA ? 'N/A' : `$${impVal.toLocaleString()}`,
    landValue: lndVal,
    totalValue: totalVal,
    propertyClass: classVal,
    useDescription: useVal,
    yearBuilt,
    buildingArea: bldgArea,
    legalDescription: attrs.CNVYNAME ? attrs.CNVYNAME.trim() : undefined,
    dcadLink: `https://www.dallascad.org/AcctDetailRes.aspx?ID=${encodeURIComponent(parcelIdVal)}`,
    mapLink: `/api/dcad-map?parcelid=${encodeURIComponent(parcelIdVal)}`,
    officialMapLink: officialMapUrl(parcelIdVal),
    isLikelyVacant,
    vacantReason,
    mapCheck: 'Pending MapCheck' as const,
    aerialImageUrl,
    coordinates,
    source: 'dcad_gis' as const,
  };
}

/**
 * Query official DCAD ArcGIS Parcel Server (https://maps.dcad.org/prdwa/rest/services/Property/ParcelQuery/MapServer/4)
 * Provides comprehensive appraisal attributes, improvement values, and geometry.
 */
export async function queryDCADParcelServer(options: {
  streetName: string;
  city?: string;
  parcelId?: string;
  limit?: number;
}): Promise<PropertyRecord[]> {
  const { streetName, city, parcelId, limit = 50 } = options;
  const whereClauses: string[] = [];
  const allCities = isAllCities(city);
  const cityClean = (city || '').trim().toUpperCase();

  if (parcelId) {
    whereClauses.push(`PARCELID = '${sqlEscape(parcelId)}'`);
  } else {
    const { rootName } = normalizeStreetName(streetName);
    whereClauses.push(`UPPER(SITEADDRESS) LIKE '%${sqlEscape(rootName)}%'`);

    if (!allCities) {
      if (cityClean === 'DALLAS') {
        // User requested: "if dallas is added on city make sure it searches dallas only"
        whereClauses.push(`UPPER(PSTLCITY) = 'DALLAS'`);
      } else {
        whereClauses.push(`UPPER(PSTLCITY) LIKE '%${sqlEscape(cityClean)}%'`);
      }
    }

    // Filter residential accounts (USECD = '1' or class contains residential or vacant)
    whereClauses.push(`(USECD = '1' OR CLASSDSCRP LIKE '%RESID%' OR CLASSDSCRP LIKE '%SFR%' OR CLASSDSCRP LIKE '%VAC%' OR USEDSCRP LIKE '%VAC%')`);
  }

  const queryParams = new URLSearchParams({
    where: whereClauses.join(' AND '),
    outFields: 'PARCELID,LOWPARCELID,SITEADDRESS,PSTLCITY,PSTLZIP5,USEDSCRP,CLASSDSCRP,IMPVALUE,LNDVALUE,CNTASSDVAL,RESYRBLT,BLDGAREA,OWNERNME1,CNVYNAME',
    returnGeometry: 'true',
    f: 'json',
  });

  // DCAD ParcelPublishing layer (public query/popup layer) - matches the outFields above
  const url = `https://maps.dcad.org/prdwa/rest/services/Property/ParcelQuery/MapServer/4/query?${queryParams.toString()}`;

  const res = await fetchWithTimeout(url, {
    headers: {
      'User-Agent': DCAD_USER_AGENT,
      'Accept': 'application/json',
    },
  });

  if (!res.ok) {
    throw new Error(`DCAD GIS Query failed with HTTP ${res.status}`);
  }

  const data = await res.json();
  if (data.error) {
    throw new Error(`DCAD GIS Error: ${data.error.message || JSON.stringify(data.error)}`);
  }

  // Narrow to the requested street BEFORE applying the limit, otherwise loose LIKE
  // matches (e.g. "ELMWOOD" for "ELM") can use up the limit and push real matches out.
  const rawFeatures: any[] = data.features || [];
  const streetFiltered = parcelId
    ? rawFeatures
    : filterToStreet(
        rawFeatures.map((f) => ({ f, address: String(f.attributes?.SITEADDRESS || '') })),
        normalizeStreetName(streetName)
      ).map((x) => x.f);
  const features = streetFiltered.slice(0, limit);
  const records: PropertyRecord[] = [];

  for (const f of features) {
    const cityVal = ((f.attributes || {}).PSTLCITY || '').trim();

    // User requirement: "if dallas is added on city make sure it searches dallas only"
    if (!parcelId && !allCities) {
      if (cityClean === 'DALLAS') {
        if (cityVal.toUpperCase() !== 'DALLAS') {
          continue; // Strictly Dallas only
        }
      } else if (!cityVal.toUpperCase().includes(cityClean)) {
        continue;
      }
    }

    records.push(gisFeatureToRecord(f));
  }

  return records;
}

/**
 * Fetch and parse a property's DCAD Detail Page (https://www.dallascad.org/AcctDetailRes.aspx?ID=...)
 * Confirms exact certified improvement and land values, main improvement notes, and links.
 */
export async function fetchDCADDetailPage(accountNumber: string): Promise<{
  /** False when the page did not load or the value fields were not found on it. */
  parsed: boolean;
  impVal: number | null;
  isNAImp: boolean;
  impDisplay?: string;
  landVal: number | null;
  totalVal: number | null;
  address: string | null;
  ownerName?: string | null;
  neighborhood: string | null;
  mapsco: string | null;
  mainImpMsg: string | null;
  isVacant: boolean;
  vacantReason?: string;
}> {
  const notParsed = {
    parsed: false,
    impVal: null,
    isNAImp: false,
    landVal: null,
    totalVal: null,
    address: null,
    neighborhood: null,
    mapsco: null,
    mainImpMsg: null,
    isVacant: false,
  };

  const url = `https://www.dallascad.org/AcctDetailRes.aspx?ID=${encodeURIComponent(accountNumber)}`;
  const res = await fetchWithTimeout(url, {
    headers: {
      'User-Agent': DCAD_USER_AGENT,
    },
  });

  if (!res.ok) {
    return notParsed;
  }

  const html = await res.text();

  // If none of the account-detail fields are on the page (error page, block page, or
  // DCAD changed its layout) we must NOT treat the missing value as "N/A = vacant".
  const looksLikeDetailPage =
    /id="ValueSummary1_lblImpVal"/i.test(html) ||
    /id="ValueSummary1_pnlValue_lblLandVal"/i.test(html) ||
    /id="ValueSummary1_pnlValue_lblTotalVal"/i.test(html) ||
    /id="PropAddr1_lblPropAddr"/i.test(html);
  if (!looksLikeDetailPage) {
    return notParsed;
  }

  const parseCurrency = (str: string | undefined | null): number | null => {
    if (!str) return null;
    const cleaned = str.replace(/[$,\s]/g, '');
    const num = parseFloat(cleaned);
    return isNaN(num) ? null : num;
  };

  const impText = html.match(/id="ValueSummary1_lblImpVal"[^>]*>([^<]+)/i)?.[1]?.trim();
  const landText = html.match(/id="ValueSummary1_pnlValue_lblLandVal"[^>]*>([^<]+)/i)?.[1]?.trim();
  const totalText = html.match(/id="ValueSummary1_pnlValue_lblTotalVal"[^>]*>([^<]+)/i)?.[1]?.trim();
  const addrText = html.match(/id="PropAddr1_lblPropAddr"[^>]*>([^<]+)/i)?.[1]?.replace(/&nbsp;/g, ' ').trim();
  const nbhdText = html.match(/id="lblNbhd"[^>]*>([^<]+)/i)?.[1]?.trim();
  const mapscoText = html.match(/id="lblMapsco"[^>]*>([^<]+)/i)?.[1]?.trim();
  const mainImpMsg = html.match(/id="MainImpRes1_lblMsg"[^>]*>([^<]+)/i)?.[1]?.trim();

  const rawImp = (impText || '').trim();
  const isNAImp = !rawImp ||
    rawImp.toUpperCase() === 'N/A' ||
    rawImp.toUpperCase() === 'NA' ||
    rawImp.toUpperCase().includes('N/A') ||
    rawImp === '--' ||
    rawImp === '-' ||
    rawImp.toUpperCase() === 'NONE' ||
    rawImp.toUpperCase().includes('NO DATA') ||
    rawImp.toUpperCase().includes('NOT APPLICABLE');

  const parsedImp = parseCurrency(rawImp);
  if (!isNAImp && parsedImp === null) {
    // Field is present but holds something we cannot read as a dollar amount.
    return notParsed;
  }
  const impVal = isNAImp ? 0 : parsedImp;
  const landVal = parseCurrency(landText);
  const totalVal = parseCurrency(totalText);

  // Parse Owner Name
  const ownerMatch = html.match(/id="lblOwner"[^>]*>([\s\S]*?)<\/span>([\s\S]*?)<br\s*\/?>/i);
  let ownerName: string | null = null;
  if (ownerMatch) {
    const raw = ownerMatch[2].replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').trim();
    if (raw && !raw.toLowerCase().includes('no data')) {
      ownerName = raw;
    }
  }

  const isZeroImp = impVal === 0 || isNAImp;
  const hasNoImpMsg = mainImpMsg?.toLowerCase().includes('no main improvement') ?? false;
  const isVacant = isZeroImp || isNAImp || hasNoImpMsg;

  const vacantReason = isNAImp
    ? 'N/A Improvement Value confirmed on DCAD certified detail page'
    : (isZeroImp ? '$0 Improvement Value confirmed on DCAD certified detail page' : undefined);

  return {
    parsed: true,
    impVal: isNAImp ? 0 : impVal,
    isNAImp,
    impDisplay: isNAImp ? 'N/A' : (impVal !== null ? `$${impVal.toLocaleString()}` : '$0'),
    landVal,
    totalVal,
    address: addrText || null,
    ownerName: ownerName || undefined,
    neighborhood: nbhdText || null,
    mapsco: mapscoText || null,
    mainImpMsg: mainImpMsg || null,
    isVacant,
    vacantReason,
  };
}

/**
 * Searches DCAD SearchAddr.aspx directly using WebForms POST request.
 * Paginates through ALL result pages until every single property is collected.
 */
export async function searchDCADWebAddrAllPages(
  streetName: string,
  cityCode: string,
  onPageGathered?: (page: number, totalPages: number, gatheredCount: number) => void
): Promise<PropertyRecord[]> {
  const parsedStreet = normalizeStreetName(streetName);
  const { rootName } = parsedStreet;

  // 1. GET search page to acquire session cookie and ViewState
  const getRes = await fetchWithTimeout('https://www.dallascad.org/SearchAddr.aspx', {
    headers: {
      'User-Agent': DCAD_USER_AGENT,
    },
  });
  if (!getRes.ok) {
    throw new Error(`DCAD SearchAddr.aspx returned HTTP ${getRes.status}`);
  }

  // Send back only the name=value part of each cookie (not "path=/; HttpOnly" attributes).
  const setCookies: string[] =
    typeof (getRes.headers as any).getSetCookie === 'function'
      ? (getRes.headers as any).getSetCookie()
      : [getRes.headers.get('set-cookie') || ''];
  const cookie = setCookies
    .map((c) => c.split(';')[0].trim())
    .filter(Boolean)
    .join('; ');
  let html = await getRes.text();

  let viewState = html.match(/name="__VIEWSTATE" id="__VIEWSTATE" value="([^"]+)"/)?.[1] || '';
  let viewStateGen = html.match(/name="__VIEWSTATEGENERATOR" id="__VIEWSTATEGENERATOR" value="([^"]+)"/)?.[1] || '';
  let eventVal = html.match(/name="__EVENTVALIDATION" id="__EVENTVALIDATION" value="([^"]+)"/)?.[1] || '';

  const params = new URLSearchParams();
  params.append('__VIEWSTATE', viewState);
  params.append('__VIEWSTATEGENERATOR', viewStateGen);
  params.append('__EVENTVALIDATION', eventVal);
  params.append('txtAddrNum', '');
  params.append('listStDir', '');
  params.append('txtStName', rootName);
  params.append('txtBldgID', '');
  params.append('txtUnitID', '');
  params.append('listCity', cityCode);
  params.append('AcctTypeCheckList1:chkAcctType:0', 'on'); // Residential only
  params.append('cmdSubmit', 'Search');

  const postRes = await fetchWithTimeout('https://www.dallascad.org/SearchAddr.aspx', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': DCAD_USER_AGENT,
      'Cookie': cookie,
    },
    body: params.toString(),
  });
  if (!postRes.ok) {
    throw new Error(`DCAD SearchAddr.aspx search returned HTTP ${postRes.status}`);
  }

  html = await postRes.text();
  const records: PropertyRecord[] = [];
  let pageNum = 1;
  const maxPagesLimit = 50; // Safeguard against infinite loops

  while (pageNum <= maxPagesLimit) {
    const pageMatch = html.match(/Page (\d+) of (\d+)/i);
    const totalPages = pageMatch ? parseInt(pageMatch[2], 10) : 1;
    const curPage = pageMatch ? parseInt(pageMatch[1], 10) : pageNum;

    // Parse results from DataGrid SearchResults1_dgResults
    const dgMatch = html.match(/<table[^>]*id="SearchResults1_dgResults"[^>]*>([\s\S]*?)<\/table>/i);
    if (!dgMatch) {
      break;
    }

    const rows = [...dgMatch[1].matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)];
    let pageCount = 0;

    for (const row of rows) {
      const linkMatch = row[1].match(/href=['"](AcctDetailRes\.aspx\?ID=([^'"]+))['"][^>]*>([\s\S]*?)<\/a>/i);
      if (!linkMatch) continue;

      const id = linkMatch[2].trim();
      const address = linkMatch[3].replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').trim();
      const tds = [...row[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map(td => td[1].replace(/<[^>]+>/g, '').trim());

      // Row format: #, Property Address, City, Owner Name, Total Value, Type
      const city = tds[2] || '';
      const ownerName = (tds[3] || '').trim();
      const totalValStr = tds[4] || '0';
      const totalValue = parseFloat(totalValStr.replace(/[$,]/g, '')) || 0;

      // Avoid duplicate accounts
      if (!records.some(r => r.accountNumber === id)) {
        records.push({
          accountNumber: id,
          address,
          city,
          zip: '', // To be filled from detail page or GIS
          ownerName: ownerName || undefined,
          improvementValue: 0,
          landValue: totalValue,
          totalValue,
          propertyClass: 'Residential',
          useDescription: 'Residential',
          yearBuilt: null,
          buildingArea: null,
          dcadLink: `https://www.dallascad.org/AcctDetailRes.aspx?ID=${encodeURIComponent(id)}`,
          mapLink: `/api/dcad-map?parcelid=${encodeURIComponent(id)}`,
          officialMapLink: officialMapUrl(id),
          isLikelyVacant: false,
          mapCheck: 'Pending MapCheck',
          source: 'dcad_search',
        });
        pageCount++;
      }
    }

    onPageGathered?.(curPage, totalPages, records.length);

    if (curPage >= totalPages) {
      break;
    }

    // Check for NEXT button
    const nextTargetMatch = html.match(/<a href="javascript:__doPostBack\(&#39;([^&]+)&#39;,&#39;&#39;\)">NEXT &gt;<\/a>/i);
    if (!nextTargetMatch) {
      break;
    }

    const nextTarget = nextTargetMatch[1];
    viewState = html.match(/name="__VIEWSTATE" id="__VIEWSTATE" value="([^"]+)"/)?.[1] || '';
    viewStateGen = html.match(/name="__VIEWSTATEGENERATOR" id="__VIEWSTATEGENERATOR" value="([^"]+)"/)?.[1] || '';
    eventVal = html.match(/name="__EVENTVALIDATION" id="__EVENTVALIDATION" value="([^"]+)"/)?.[1] || '';

    const nextParams = new URLSearchParams();
    nextParams.append('__VIEWSTATE', viewState);
    nextParams.append('__VIEWSTATEGENERATOR', viewStateGen);
    nextParams.append('__EVENTVALIDATION', eventVal);
    nextParams.append('__EVENTTARGET', nextTarget);
    nextParams.append('__EVENTARGUMENT', '');

    const nextRes = await fetchWithTimeout('https://www.dallascad.org/SearchAddr.aspx', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': DCAD_USER_AGENT,
        'Cookie': cookie,
      },
      body: nextParams.toString(),
    });
    if (!nextRes.ok) {
      throw new Error(`DCAD SearchAddr.aspx page ${pageNum + 1} returned HTTP ${nextRes.status}`);
    }

    html = await nextRes.text();
    pageNum++;
  }

  // Keep only the street (and direction / street type) the user typed.
  return filterToStreet(records, parsedStreet);
}

/**
 * Fetch 2026 Hybrid Map screenshot data and parcel boundary geometry for a specific account.
 */
export async function fetchParcelSnapshot(
  accountNumber: string,
  optionalAddress?: string
): Promise<import('../src/types/property.js').ParcelSnapshotData | null> {
  const cleanAcc = (accountNumber || '').trim();

  // Helper to query DCAD ParcelQuery MapServer 4 (ParcelPublishing layer)
  const queryGIS = async (whereClause: string) => {
    const queryParams = new URLSearchParams({
      where: whereClause,
      returnGeometry: 'true',
      f: 'json',
      outFields: 'PARCELID,LOWPARCELID,SITEADDRESS,PSTLCITY,PSTLZIP5,IMPVALUE,LNDVALUE,CNTASSDVAL,OWNERNME1,CNVYNAME,CLASSDSCRP,USEDSCRP',
    });
    const url = `https://maps.dcad.org/prdwa/rest/services/Property/ParcelQuery/MapServer/4/query?${queryParams.toString()}`;
    const res = await fetchWithTimeout(url, {
      headers: {
        'User-Agent': DCAD_USER_AGENT,
        'Accept': 'application/json',
      },
    });
    if (!res.ok) throw new Error(`DCAD GIS Query failed with HTTP ${res.status}`);
    const data = await res.json();
    if (data.error) {
      throw new Error(`DCAD GIS Error: ${data.error.message || JSON.stringify(data.error)}`);
    }
    return data.features?.[0] || null;
  };

  {
    let feature: any = null;

    // 1. Try querying by PARCELID or LOWPARCELID
    if (cleanAcc) {
      feature = await queryGIS(`(PARCELID = '${sqlEscape(cleanAcc)}' OR LOWPARCELID = '${sqlEscape(cleanAcc)}')`);
    }

    // 2. If not found and address is available, try the exact site address. The match is
    //    anchored at the start so "2800 PENNSYLVANIA" can never pick up "12800 PENNSYLVANIA".
    if (!feature && optionalAddress && optionalAddress.trim()) {
      const addr = optionalAddress.trim().toUpperCase().replace(/\s+/g, ' ');
      feature = await queryGIS(`UPPER(SITEADDRESS) LIKE '${sqlEscape(addr)}%'`);
    }

    const attrs = feature?.attributes || {};
    let rings: [number, number][][] = [];
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;

    if (feature?.geometry && feature.geometry.rings) {
      rings = feature.geometry.rings;
      for (const ring of rings) {
        for (const pt of ring) {
          if (pt[0] < minX) minX = pt[0];
          if (pt[0] > maxX) maxX = pt[0];
          if (pt[1] < minY) minY = pt[1];
          if (pt[1] > maxY) maxY = pt[1];
        }
      }
    }

    // No parcel geometry: say so. (This used to fall back to a fixed spot in Dallas and
    // draw a "TARGET PARCEL" box on an unrelated block.)
    if (!isFinite(minX) || !isFinite(minY)) {
      return null;
    }

    const padX = Math.max((maxX - minX) * 0.55, 45);
    const padY = Math.max((maxY - minY) * 0.55, 45);
    // Match the 3:2 image we request so the drawn outline lines up with the photo.
    const fitted = fitBboxToAspect(minX - padX, minY - padY, maxX + padX, maxY + padY);
    const bMinX = fitted.minX;
    const bMinY = fitted.minY;
    const bMaxX = fitted.maxX;
    const bMaxY = fitted.maxY;

    const bboxStr = `${bMinX},${bMinY},${bMaxX},${bMaxY}`;
    // Official DCAD Aerial Photography
    const aerialImageUrl = `/api/dcad-aerial-2026?bbox=${encodeURIComponent(bboxStr)}&size=${SNAPSHOT_WIDTH},${SNAPSHOT_HEIGHT}`;
    const parcelOverlayUrl = `/api/dcad-parcel-overlay?bbox=${encodeURIComponent(bboxStr)}&size=${SNAPSHOT_WIDTH},${SNAPSHOT_HEIGHT}`;

    return {
      accountNumber: (attrs.PARCELID || cleanAcc).trim(),
      address: (attrs.SITEADDRESS || optionalAddress || '').trim(),
      city: (attrs.PSTLCITY || 'DALLAS').trim(),
      zip: (attrs.PSTLZIP5 || '').trim(),
      ownerName: (attrs.OWNERNME1 || attrs.CNVYNAME || '').trim() || undefined,
      landValue: Number(attrs.LNDVALUE ?? 0),
      improvementValue: Number(attrs.IMPVALUE ?? 0),
      totalValue: Number(attrs.CNTASSDVAL ?? 0),
      propertyClass: attrs.CLASSDSCRP?.trim(),
      useDescription: attrs.USEDSCRP?.trim(),
      legalDescription: attrs.CNVYNAME?.trim(),
      bbox: { minX: bMinX, minY: bMinY, maxX: bMaxX, maxY: bMaxY },
      center: { x: (minX + maxX) / 2, y: (minY + maxY) / 2 },
      aerialImageUrl,
      parcelOverlayUrl,
      rings,
    };
  }
}

// ---------------------------------------------------------------------------------------
// Address import: look up specific addresses (or account numbers) instead of a whole street
// ---------------------------------------------------------------------------------------

export interface ParsedAddress {
  /** The line exactly as the person supplied it. */
  raw: string;
  /** Set when the line is a DCAD account number rather than a street address. */
  accountNumber?: string;
  houseNumber?: string;
  /** Street part without the house number or unit, e.g. "E 11TH ST". */
  street?: string;
  city?: string;
  zip?: string;
}

/** DCAD account numbers are long digit strings (17 chars, sometimes with a letter). */
const ACCOUNT_RE = /^[0-9]{3}[0-9A-Za-z]{7,27}$/;

/**
 * Break one pasted line ("2800 Pennsylvania Ave, Dallas, TX 75215") into parts.
 * Also copes with no commas ("2800 Pennsylvania Ave Dallas TX 75215"), unit numbers
 * ("Apt 4", "#12") and bare DCAD account numbers.
 */
export function parseAddressLine(rawLine: string): ParsedAddress | null {
  const raw = (rawLine || '').trim();
  if (!raw) return null;

  const compact = raw.replace(/\s+/g, '');
  if (!/\s/.test(raw) && ACCOUNT_RE.test(compact) && /^[0-9]+$/.test(compact.slice(0, 5))) {
    return { raw, accountNumber: compact.toUpperCase() };
  }

  let text = raw.toUpperCase().replace(/\s+/g, ' ').replace(/[.]/g, '');
  let zip: string | undefined;
  const zipMatch = text.match(/\b(\d{5})(?:-\d{4})?\s*$/);
  if (zipMatch) {
    zip = zipMatch[1];
    text = text.slice(0, zipMatch.index).trim().replace(/,\s*$/, '');
  }
  text = text.replace(/[,\s]+(TX|TEXAS)\s*$/, '').trim();

  const parts = text.split(',').map((p) => p.trim()).filter(Boolean);
  let streetPart = parts[0] || '';
  let city: string | undefined = parts.length > 1 ? parts[1] : undefined;

  // No commas: peel a trailing known city name off the street ("... AVE DALLAS").
  if (!city) {
    const names = DALLAS_COUNTY_CITIES.filter((c) => c.code !== '')
      .map((c) => c.name)
      .sort((a, b) => b.length - a.length);
    for (const name of names) {
      if (streetPart.endsWith(' ' + name) && streetPart.length > name.length + 1) {
        const remainder = streetPart.slice(0, streetPart.length - name.length - 1).trim();
        // Only a city if a house number AND a street name remain ("400 DESOTO" is a street).
        if (!/^\d+[A-Z]?\s+\S/.test(remainder)) continue;
        city = name;
        streetPart = remainder;
        break;
      }
    }
  }

  // Drop a trailing unit ("APT 4", "UNIT B", "STE 200", "#12").
  streetPart = streetPart.replace(/\s+(APT|UNIT|STE|SUITE|BLDG|LOT|#)\s*#?\s*[A-Z0-9-]+$/, '').replace(/\s+#\s*[A-Z0-9-]+$/, '').trim();

  const m = streetPart.match(/^(\d+[A-Z]?)\s+(.+)$/);
  if (!m) return { raw, city, zip }; // no usable house number + street
  return { raw, houseNumber: m[1], street: m[2], city, zip };
}

/**
 * Find the DCAD parcel(s) for one parsed address (or account number) using the same
 * ParcelQuery layer the street search uses. Returns [] when nothing matches.
 */
export async function lookupParcelsForAddress(addr: ParsedAddress): Promise<PropertyRecord[]> {
  const queryGIS = async (where: string): Promise<any[]> => {
    const queryParams = new URLSearchParams({
      where,
      outFields: 'PARCELID,LOWPARCELID,SITEADDRESS,PSTLCITY,PSTLZIP5,USEDSCRP,CLASSDSCRP,IMPVALUE,LNDVALUE,CNTASSDVAL,RESYRBLT,BLDGAREA,OWNERNME1,CNVYNAME',
      returnGeometry: 'true',
      f: 'json',
    });
    const url = `https://maps.dcad.org/prdwa/rest/services/Property/ParcelQuery/MapServer/4/query?${queryParams.toString()}`;
    const res = await fetchWithTimeout(url, {
      headers: { 'User-Agent': DCAD_USER_AGENT, Accept: 'application/json' },
    });
    if (!res.ok) throw new Error(`DCAD GIS Query failed with HTTP ${res.status}`);
    const data = await res.json();
    if (data.error) throw new Error(`DCAD GIS Error: ${data.error.message || JSON.stringify(data.error)}`);
    return data.features || [];
  };

  if (addr.accountNumber) {
    const acc = sqlEscape(addr.accountNumber);
    const feats = await queryGIS(`(PARCELID = '${acc}' OR LOWPARCELID = '${acc}')`);
    return feats.slice(0, 1).map(gisFeatureToRecord);
  }

  if (!addr.houseNumber || !addr.street) return [];

  const parsedStreet = normalizeStreetName(addr.street);
  const feats = await queryGIS(
    `UPPER(SITEADDRESS) LIKE '${sqlEscape(addr.houseNumber)} %' AND UPPER(SITEADDRESS) LIKE '%${sqlEscape(parsedStreet.rootName)}%'`
  );

  // Keep the exact street (direction / street type), then the exact house number.
  const withAddr = feats.map((f) => ({ f, address: String(f.attributes?.SITEADDRESS || '') }));
  const onStreet = filterToStreet(withAddr, parsedStreet);
  const rootRe = new RegExp(
    `(^|\\s)${parsedStreet.rootName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\s|$)`
  );
  let matches = onStreet.filter(
    (x) =>
      x.address.toUpperCase().startsWith(addr.houseNumber + ' ') &&
      rootRe.test(x.address.toUpperCase())
  );

  // Prefer the city / zip the person gave, but never discard a match only because of them.
  if (addr.zip) {
    const byZip = matches.filter((x) => String(x.f.attributes?.PSTLZIP5 || '').startsWith(addr.zip as string));
    if (byZip.length > 0) matches = byZip;
  }
  if (addr.city) {
    const wantCity = addr.city.toUpperCase();
    const byCity = matches.filter((x) => {
      const c = String(x.f.attributes?.PSTLCITY || '').trim().toUpperCase();
      return c === wantCity || c.startsWith(wantCity) || wantCity.startsWith(c);
    });
    if (byCity.length > 0) matches = byCity;
  }

  return matches.map((x) => gisFeatureToRecord(x.f));
}
