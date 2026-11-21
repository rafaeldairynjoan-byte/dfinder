import React, { useRef, useState } from 'react';
import { Search, Loader2, Sparkles, Filter, Info, Building, Upload, ClipboardList, X } from 'lucide-react';
import type { CityOption } from '../types/property.ts';

interface SearchFormProps {
  cities: CityOption[];
  isLoading: boolean;
  onSearch: (params: { streetName: string; city: string; zipFilter?: string; maxResults?: number }) => void;
  onCancel?: () => void;
  /** Look up specific addresses (one per line) instead of searching a whole street. */
  onImport?: (params: { addresses: string[]; city: string }) => void;
}

/** Minimal CSV line splitter that understands double-quoted fields. */
function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') quoted = false;
      else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { out.push(cur.trim()); cur = ''; }
    else cur += ch;
  }
  out.push(cur.trim());
  return out;
}

/**
 * Turn the text of an uploaded .csv / .txt into one address per line.
 * A CSV with an address column (plus optional city / zip / account columns) is combined into
 * "address, city, zip" lines; anything else is treated as one address (or account number) per line.
 */
export function addressesFromText(text: string): string[] {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0) return [];
  const header = splitCsvLine(lines[0]).map((h) => h.toLowerCase().replace(/[^a-z]/g, ''));
  const find = (names: string[]) => header.findIndex((h) => names.includes(h));
  const addrIdx = find(['address', 'siteaddress', 'propertyaddress', 'streetaddress', 'street', 'addr']);
  const acctIdx = find(['account', 'accountnumber', 'acct', 'parcelid', 'accountno']);
  if (header.length > 1 && (addrIdx >= 0 || acctIdx >= 0)) {
    const cityIdx = find(['city', 'propertycity', 'sitecity']);
    const zipIdx = find(['zip', 'zipcode', 'postalcode', 'zip5']);
    return lines.slice(1).map((l) => {
      const c = splitCsvLine(l);
      const addr = addrIdx >= 0 ? c[addrIdx] : '';
      if (!addr && acctIdx >= 0) return (c[acctIdx] || '').replace(/\D/g, '') ? c[acctIdx] : '';
      return [addr, cityIdx >= 0 ? c[cityIdx] : '', zipIdx >= 0 ? c[zipIdx] : ''].filter(Boolean).join(', ');
    }).filter(Boolean);
  }
  return lines;
}

export const SearchForm: React.FC<SearchFormProps> = ({
  cities,
  isLoading,
  onSearch,
  onCancel,
  onImport,
}) => {
  const [streetName, setStreetName] = useState('Pennsylvania Ave');
  const [city, setCity] = useState('Dallas');
  const [zipFilter, setZipFilter] = useState('');
  const [maxResults, setMaxResults] = useState(0);
  const [showAdvanced, setShowAdvanced] = useState(false);

  // Address import
  const [mode, setMode] = useState<'street' | 'import'>('street');
  const [importText, setImportText] = useState('');
  const [importCity, setImportCity] = useState('Dallas');
  const [fileName, setFileName] = useState('');
  const [importError, setImportError] = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);

  const importLines = importText.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);

  const handleFile = async (file: File | undefined) => {
    if (!file) return;
    setImportError('');
    if (file.size > 2 * 1024 * 1024) {
      setImportError('That file is larger than 2 MB. Split it into smaller files.');
      return;
    }
    try {
      const text = await file.text();
      const found = addressesFromText(text);
      if (found.length === 0) {
        setImportError('No addresses were found in that file.');
        return;
      }
      setFileName(file.name);
      setImportText((prev) => (prev.trim() ? prev.trim() + '\n' : '') + found.join('\n'));
    } catch {
      setImportError('Could not read that file. Use a .csv or .txt file.');
    } finally {
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const handleImportSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (importLines.length === 0 || !onImport) return;
    onImport({ addresses: importLines, city: importCity.trim() });
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!streetName.trim()) return;
    onSearch({
      streetName: streetName.trim(),
      city: city.trim() || 'Dallas',
      zipFilter: zipFilter.trim() || undefined,
      maxResults,
    });
  };

  const sampleStreets = [
    { street: 'Pennsylvania Ave', city: 'Dallas', zip: '75215', label: 'Pennsylvania Ave (Dallas)' },
    { street: 'Malcolm X Blvd', city: 'Dallas', zip: '75215', label: 'Malcolm X Blvd (Dallas)' },
    { street: 'Grand Ave', city: 'Dallas', zip: '75215', label: 'Grand Ave (Dallas)' },
    { street: 'Garland Ave', city: 'Garland', zip: '75040', label: 'Garland Ave (Garland)' },
    { street: 'E 11th St', city: 'Dallas', zip: '75203', label: 'E 11th St (Dallas)' },
  ];

  return (
    <div className="bg-white rounded-xl border border-slate-200 shadow-sm p-5 sm:p-6 mb-6">
      <div className="mb-4">
        <h2 className="text-lg font-semibold text-slate-900 flex items-center gap-2">
          <span>Search DCAD Residential Properties</span>
          <span className="text-xs font-normal text-slate-500 bg-slate-100 px-2 py-0.5 rounded-full">
            Dallas Central Appraisal District
          </span>
        </h2>
        <p className="text-xs sm:text-sm text-slate-500 mt-1">
          Searches <code className="text-slate-700 bg-slate-100 px-1 py-0.5 rounded">https://www.dallascad.org/SearchAddr.aspx</code>,
          inspects each property detail page for <span className="font-semibold text-emerald-700">$0 / N/A improvement value &amp; vacant land use</span>, and enables 2026 map cross-checking.
        </p>
      </div>

      {/* Mode switch: search a whole street, or import specific addresses */}
      {onImport && (
        <div className="inline-flex rounded-lg bg-slate-100 p-1 mb-4 text-xs font-semibold">
          <button
            type="button"
            onClick={() => setMode('street')}
            className={`px-3 py-1.5 rounded-md inline-flex items-center gap-1.5 cursor-pointer transition-colors ${mode === 'street' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500 hover:text-slate-800'}`}
          >
            <Search className="w-3.5 h-3.5" />
            Search by street
          </button>
          <button
            type="button"
            onClick={() => setMode('import')}
            className={`px-3 py-1.5 rounded-md inline-flex items-center gap-1.5 cursor-pointer transition-colors ${mode === 'import' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500 hover:text-slate-800'}`}
          >
            <ClipboardList className="w-3.5 h-3.5" />
            Import addresses
          </button>
        </div>
      )}

      {mode === 'import' && onImport && (
        <form onSubmit={handleImportSubmit} className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-12 gap-4">
            <div className="md:col-span-8">
              <label htmlFor="importAddresses" className="block text-xs font-bold uppercase tracking-wider text-slate-700 mb-1.5">
                Addresses <span className="text-rose-500">*</span>
                <span className="ml-2 normal-case tracking-normal font-normal text-slate-500">
                  one per line • {importLines.length} entered
                </span>
              </label>
              <textarea
                id="importAddresses"
                value={importText}
                onChange={(e) => setImportText(e.target.value)}
                rows={7}
                placeholder={'2800 Pennsylvania Ave, Dallas, TX 75215\n1234 E 11th St, Dallas\n00000776084000000   (a DCAD account number also works)'}
                className="w-full px-3.5 py-2.5 rounded-lg border border-slate-300 focus:outline-none focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500 text-slate-900 text-sm font-mono placeholder:text-slate-400"
              />
            </div>

            <div className="md:col-span-4 space-y-3">
              <div>
                <label htmlFor="importCity" className="block text-xs font-bold uppercase tracking-wider text-slate-700 mb-1.5">
                  Default City
                </label>
                <input
                  id="importCity"
                  type="text"
                  list="dallas-cities"
                  value={importCity}
                  onChange={(e) => setImportCity(e.target.value)}
                  placeholder="Used when a line has no city"
                  className="w-full px-3.5 py-2.5 rounded-lg border border-slate-300 focus:outline-none focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500 text-slate-900 text-sm font-medium"
                />
                <datalist id="dallas-cities">
                  {cities.map((c) => (
                    <option key={c.code || 'all'} value={c.name} />
                  ))}
                </datalist>
                <p className="text-[11px] text-slate-500 mt-1">
                  Only a preference: an address that exists in another Dallas County city is still found.
                </p>
              </div>

              <div>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".csv,.txt,.tsv,text/csv,text/plain"
                  className="hidden"
                  onChange={(e) => handleFile(e.target.files?.[0])}
                />
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  className="w-full inline-flex items-center justify-center gap-2 px-3 py-2.5 rounded-lg border border-dashed border-slate-300 bg-slate-50 hover:bg-slate-100 text-slate-700 text-sm font-medium cursor-pointer transition-colors"
                >
                  <Upload className="w-4 h-4" />
                  <span>Upload CSV / TXT file</span>
                </button>
                {fileName && (
                  <p className="text-[11px] text-slate-500 mt-1">Added from {fileName}</p>
                )}
                <p className="text-[11px] text-slate-500 mt-1">
                  A CSV with an <span className="font-semibold">Address</span> column (optional City, Zip, Account) or a plain list.
                </p>
              </div>
            </div>
          </div>

          {importError && <p className="text-xs text-rose-600 font-medium">{importError}</p>}

          <div className="flex flex-wrap items-center gap-2 pt-2 border-t border-slate-100">
            <button
              type="submit"
              disabled={isLoading || importLines.length === 0}
              className="inline-flex items-center justify-center gap-2 px-5 py-2.5 rounded-lg bg-emerald-600 hover:bg-emerald-700 disabled:bg-slate-300 text-white font-medium text-sm transition-colors shadow-sm disabled:cursor-not-allowed cursor-pointer"
            >
              {isLoading ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" />
                  <span>Checking...</span>
                </>
              ) : (
                <>
                  <Search className="w-4 h-4" />
                  <span>Check {importLines.length || ''} Address{importLines.length === 1 ? '' : 'es'}</span>
                </>
              )}
            </button>
            {isLoading && onCancel && (
              <button
                type="button"
                onClick={onCancel}
                className="px-3 py-2.5 rounded-lg border border-slate-300 bg-white hover:bg-slate-50 text-slate-700 text-sm font-medium transition-colors"
              >
                Stop
              </button>
            )}
            {importText && !isLoading && (
              <button
                type="button"
                onClick={() => { setImportText(''); setFileName(''); setImportError(''); }}
                className="inline-flex items-center gap-1 px-3 py-2.5 rounded-lg text-slate-500 hover:text-slate-800 text-xs font-medium cursor-pointer"
              >
                <X className="w-3.5 h-3.5" />
                Clear
              </button>
            )}
            <span className="text-[11px] text-slate-500">
              Each address gets the same DCAD checks, aerial imagery and MapCheck review as a street search (up to 500 per import).
            </span>
          </div>
        </form>
      )}

      {mode === 'street' && (
      <form onSubmit={handleSubmit} className="space-y-4">
        <div className="grid grid-cols-1 md:grid-cols-12 gap-4 items-end">
          {/* Street Name input */}
          <div className="md:col-span-5">
            <label htmlFor="streetName" className="block text-xs font-bold uppercase tracking-wider text-slate-700 mb-1.5">
              Street Name <span className="text-rose-500">*</span>
            </label>
            <div className="relative">
              <input
                id="streetName"
                type="text"
                value={streetName}
                onChange={(e) => setStreetName(e.target.value)}
                placeholder="e.g. Pennsylvania, Malcolm X, Grand, Elm"
                required
                className="w-full px-3.5 py-2.5 rounded-lg border border-slate-300 focus:outline-none focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500 text-slate-900 text-sm placeholder:text-slate-400 font-medium"
              />
            </div>
          </div>

          {/* City input */}
          <div className="md:col-span-4">
            <label htmlFor="city" className="block text-xs font-bold uppercase tracking-wider text-slate-700 mb-1.5">
              City <span className="text-rose-500">*</span>
            </label>
            <div className="relative">
              <input
                id="city"
                type="text"
                list="dallas-cities"
                value={city}
                onChange={(e) => setCity(e.target.value)}
                placeholder="Dallas, Garland, Irving, etc."
                required
                className="w-full px-3.5 py-2.5 rounded-lg border border-slate-300 focus:outline-none focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500 text-slate-900 text-sm font-medium"
              />
              <datalist id="dallas-cities">
                {cities.map((c) => (
                  <option key={c.code || 'all'} value={c.name} />
                ))}
              </datalist>
            </div>
            {city.trim().toUpperCase() === 'DALLAS' && (
              <p className="text-[11px] text-emerald-700 font-semibold mt-1 flex items-center gap-1">
                <span>✓ Dallas only:</span>
                <span className="font-normal text-slate-500">Excludes neighboring municipalities (Garland, Irving, etc.)</span>
              </p>
            )}
          </div>

          {/* Search Button */}
          <div className="md:col-span-3 flex gap-2">
            <button
              type="submit"
              disabled={isLoading || !streetName.trim()}
              className="flex-1 inline-flex items-center justify-center gap-2 px-5 py-2.5 rounded-lg bg-emerald-600 hover:bg-emerald-700 disabled:bg-slate-300 text-white font-medium text-sm transition-colors shadow-sm disabled:cursor-not-allowed cursor-pointer"
            >
              {isLoading ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" />
                  <span>Searching...</span>
                </>
              ) : (
                <>
                  <Search className="w-4 h-4" />
                  <span>Search</span>
                </>
              )}
            </button>

            {isLoading && onCancel && (
              <button
                type="button"
                onClick={onCancel}
                className="px-3 py-2.5 rounded-lg border border-slate-300 bg-white hover:bg-slate-50 text-slate-700 text-sm font-medium transition-colors"
                title="Cancel Search"
              >
                Stop
              </button>
            )}
          </div>
        </div>

        {/* Optional Zip Code filter & Advanced options toggle */}
        <div className="pt-2 border-t border-slate-100 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
          <div className="flex items-center gap-4">
            <button
              type="button"
              onClick={() => setShowAdvanced(!showAdvanced)}
              className="text-xs text-slate-600 hover:text-slate-900 inline-flex items-center gap-1 font-medium cursor-pointer"
            >
              <Filter className="w-3.5 h-3.5 text-slate-500" />
              <span>{showAdvanced ? 'Hide Optional Zip & Filters' : 'Optional Zip Code Filter & Limits'}</span>
            </button>

            <span className="hidden sm:inline-block text-slate-300">|</span>

            {/* Quick preset chips */}
            <div className="hidden lg:flex items-center gap-1.5 text-xs text-slate-500">
              <span className="flex items-center gap-1 text-slate-400">
                <Sparkles className="w-3 h-3 text-amber-500" />
                Quick test:
              </span>
              {sampleStreets.slice(0, 3).map((item) => (
                <button
                  key={item.label}
                  type="button"
                  onClick={() => {
                    setStreetName(item.street);
                    setCity(item.city);
                    setZipFilter('');
                  }}
                  className="px-2 py-0.5 rounded bg-slate-100 hover:bg-slate-200 text-slate-700 font-medium transition-colors cursor-pointer text-xs"
                >
                  {item.label}
                </button>
              ))}
            </div>
          </div>
        </div>

        {showAdvanced && (
          <div className="p-4 rounded-lg bg-slate-50 border border-slate-200/80 grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-4 text-xs">
            <div>
              <label htmlFor="zipFilter" className="block font-medium text-slate-700 mb-1">
                Zip Code (Post-Search Filter)
              </label>
              <input
                id="zipFilter"
                type="text"
                value={zipFilter}
                onChange={(e) => setZipFilter(e.target.value)}
                placeholder="e.g. 75215"
                className="w-full px-3 py-1.5 rounded-md border border-slate-300 bg-white text-slate-900 text-xs focus:ring-1 focus:ring-emerald-500"
              />
              <p className="text-[11px] text-slate-500 mt-1 flex items-start gap-1">
                <Info className="w-3 h-3 text-blue-500 shrink-0 mt-0.5" />
                <span>DCAD form filters by street &amp; city; zip is post-filtered from property records.</span>
              </p>
            </div>

            <div>
              <label htmlFor="maxResults" className="block font-medium text-slate-700 mb-1">
                Scan Limit (Max Properties)
              </label>
              <select
                id="maxResults"
                value={maxResults}
                onChange={(e) => setMaxResults(Number(e.target.value))}
                className="w-full px-3 py-1.5 rounded-md border border-slate-300 bg-white text-slate-900 text-xs focus:ring-1 focus:ring-emerald-500"
              >
                <option value={0}>No limit - all properties (default)</option>
                <option value={20}>20 properties</option>
                <option value={50}>50 properties</option>
                <option value={100}>100 properties</option>
                <option value={200}>200 properties</option>
              </select>
              <p className="text-[11px] text-slate-500 mt-1">
                Limits number of residential parcels inspected for this street. You are warned when a limit cuts a search short.
              </p>
            </div>

            <div className="sm:col-span-2 md:col-span-1">
              <label className="block font-medium text-slate-700 mb-1">
                Quick Preset Streets
              </label>
              <div className="flex flex-wrap gap-1.5">
                {sampleStreets.map((item) => (
                  <button
                    key={item.label}
                    type="button"
                    onClick={() => {
                      setStreetName(item.street);
                      setCity(item.city);
                      setZipFilter(item.zip);
                    }}
                    className="px-2 py-1 rounded bg-white border border-slate-200 hover:border-emerald-300 hover:text-emerald-700 text-slate-600 text-xs font-medium transition-colors"
                  >
                    {item.street} ({item.city})
                  </button>
                ))}
              </div>
            </div>
          </div>
        )}
      </form>
      )}
    </div>
  );
};
