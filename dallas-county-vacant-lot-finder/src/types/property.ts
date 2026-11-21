export type MapCheckValue =
  | 'MapCheck - Vacant Lot'
  | 'MapCheck - Had Structures'
  | 'MapCheck - Unclear'
  | 'Pending MapCheck';

export interface PropertyRecord {
  accountNumber: string;
  address: string;
  city: string;
  zip: string;
  ownerName?: string;
  improvementValue: number;
  improvementValueDisplay?: string;
  landValue: number;
  totalValue: number;
  propertyClass: string;
  useDescription: string;
  yearBuilt: number | null;
  buildingArea: number | null;
  legalDescription?: string;
  dcadLink: string;
  /** In-app map embed (proxied through this server). Not valid outside the app. */
  mapLink: string;
  /** Public DCAD map URL for this parcel. Use this one in exports and shared links. */
  officialMapLink?: string;
  isLikelyVacant: boolean;
  vacantReason?: string;
  mapCheck: MapCheckValue;
  mapCheckNotes?: string;
  mapCheckExplanation?: string;
  autoChecked?: boolean;
  /** True once a person (not the records pre-screen) has set the MapCheck status. */
  manualChecked?: boolean;
  aerialImageUrl?: string;
  mapLoadError?: boolean;
  coordinates?: { x: number; y: number } | null;
  source: 'dcad_search' | 'dcad_gis';
}

export interface CityOption {
  code: string;
  name: string;
}

export interface SearchProgress {
  stage: 'idle' | 'searching' | 'inspecting' | 'filtering' | 'completed' | 'error';
  message: string;
  percent: number;
  current?: number;
  total?: number;
  foundVacant?: number;
}

export interface SearchParams {
  streetName: string;
  city: string;
  zipFilter?: string;
  maxResults?: number;
  vacantOnly?: boolean;
}

export interface ParcelSnapshotData {
  accountNumber: string;
  address: string;
  city: string;
  zip: string;
  ownerName?: string;
  landValue: number;
  improvementValue: number;
  totalValue: number;
  propertyClass?: string;
  useDescription?: string;
  legalDescription?: string;
  bbox: { minX: number; minY: number; maxX: number; maxY: number };
  center: { x: number; y: number };
  aerialImageUrl: string;
  parcelOverlayUrl: string;
  rings: [number, number][][];
}

/** What happened to each imported address that did not end up in the results table. */
export interface ImportSummary {
  /** Addresses (unique lines) that were looked up. */
  requested: number;
  /** DCAD parcels that were matched and checked. */
  matched: number;
  notFound: { input: string; reason: string }[];
  notVacant: { input: string; address: string; accountNumber: string; dcadLink: string; reason: string }[];
}
