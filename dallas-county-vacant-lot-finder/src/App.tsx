import React, { useState, useEffect, useRef } from 'react';
import { Header } from './components/Header.tsx';
import { SearchForm } from './components/SearchForm.tsx';
import { ProgressIndicator } from './components/ProgressIndicator.tsx';
import { ResultsTable } from './components/ResultsTable.tsx';
import { VisualVerificationModal } from './components/VisualVerificationModal.tsx';
import { ExportModal } from './components/ExportModal.tsx';
import type { CityOption, PropertyRecord, SearchProgress, SearchParams, MapCheckValue, ImportSummary } from './types/property.ts';
import {
  Trees,
  CheckCircle2,
  MapPin,
  ExternalLink,
  ShieldCheck,
  AlertCircle,
  Eye,
  Download,
  Building,
  Layers,
} from 'lucide-react';

export default function App() {
  const [cities, setCities] = useState<CityOption[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [progress, setProgress] = useState<SearchProgress>({
    stage: 'idle',
    message: '',
    percent: 0,
  });
  const [records, setRecords] = useState<PropertyRecord[]>([]);
  const [searchParams, setSearchParams] = useState<SearchParams>({
    streetName: 'Pennsylvania Ave',
    city: 'Dallas',
    zipFilter: '',
    maxResults: 0,
  });
  const [error, setError] = useState<string | null>(null);
  // Non-fatal problems reported by the server (partial results, scan limit, DCAD outages)
  const [warnings, setWarnings] = useState<string[]>([]);
  // What happened to each imported address (not found / not a vacant candidate)
  const [importSummary, setImportSummary] = useState<ImportSummary | null>(null);

  // Verification Modal State
  const [isMapModalOpen, setIsMapModalOpen] = useState(false);
  const [activeLotIndex, setActiveLotIndex] = useState(0);
  const [isAutoChecking, setIsAutoChecking] = useState(false);

  // Export Modal State
  const [isExportModalOpen, setIsExportModalOpen] = useState(false);

  const eventSourceRef = useRef<EventSource | null>(null);
  // Aborts an in-flight address import (Stop button / new search)
  const importAbortRef = useRef<AbortController | null>(null);
  // Incremented on every search so responses from an older search are ignored
  const searchIdRef = useRef(0);

  // Fetch Dallas County cities on load
  useEffect(() => {
    fetch('/api/cities')
      .then((res) => res.json())
      .then((data: CityOption[]) => {
        setCities(data);
      })
      .catch((err) => {
        console.error('Failed to load cities:', err);
      });
  }, []);

  // Initial search for Pennsylvania Ave, Dallas
  useEffect(() => {
    handleSearch({
      streetName: 'Pennsylvania Ave',
      city: 'Dallas',
      zipFilter: '',
      maxResults: 0,
    });
    // Close the stream when the page unmounts so the server stops scraping
    return () => {
      searchIdRef.current++;
      eventSourceRef.current?.close();
      eventSourceRef.current = null;
    };
  }, []);

  // Handle Search Submission with Server-Sent Events for live progress
  const handleSearch = async (params: {
    streetName: string;
    city: string;
    zipFilter?: string;
    maxResults?: number;
  }) => {
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
      eventSourceRef.current = null;
    }

    importAbortRef.current?.abort();
    importAbortRef.current = null;
    setImportSummary(null);

    const searchId = ++searchIdRef.current;
    const isCurrent = () => searchIdRef.current === searchId;

    // Immediately remove results of previous search when searching a new address
    setRecords([]);
    setActiveLotIndex(0);

    setIsLoading(true);
    setError(null);
    setWarnings([]);
    setSearchParams(params);
    setProgress({
      stage: 'searching',
      message: `Searching DCAD public records for "${params.streetName}" in ${params.city}...`,
      percent: 5,
    });

    const streamUrl = `/api/search/stream?streetName=${encodeURIComponent(
      params.streetName
    )}&city=${encodeURIComponent(params.city)}&zipFilter=${encodeURIComponent(
      params.zipFilter || ''
    )}&maxResults=${params.maxResults || 0}`;

    const failSearch = (message: string) => {
      setError(message);
      setProgress({ stage: 'error', message, percent: 0 });
      setIsLoading(false);
    };

    try {
      const sse = new EventSource(streamUrl);
      eventSourceRef.current = sse;
      let receivedAnything = false;
      let finished = false;

      sse.addEventListener('progress', (e) => {
        if (!isCurrent()) return;
        receivedAnything = true;
        try {
          const data: SearchProgress = JSON.parse((e as MessageEvent).data);
          setProgress(data);
        } catch (err) {
          console.error('Error parsing progress SSE:', err);
        }
      });

      sse.addEventListener('lot_found', (e) => {
        if (!isCurrent()) return;
        try {
          const lot: PropertyRecord = JSON.parse((e as MessageEvent).data);
          setRecords((prev) => {
            const exists = prev.some((r) => r.accountNumber === lot.accountNumber);
            if (exists) {
              return prev.map((r) => (r.accountNumber === lot.accountNumber ? lot : r));
            }
            return [...prev, lot];
          });
        } catch (err) {
          console.error('Error parsing lot SSE:', err);
        }
      });

      sse.addEventListener('done', (e) => {
        finished = true;
        sse.close();
        if (!isCurrent()) return;
        try {
          const data = JSON.parse((e as MessageEvent).data);
          if (data.results) {
            setRecords(data.results);
          }
          setWarnings(Array.isArray(data.warnings) ? data.warnings : []);
          setProgress({
            stage: 'completed',
            message: 'Search completed successfully.',
            percent: 100,
          });
        } catch (err) {
          console.error('Error parsing done SSE:', err);
        } finally {
          setIsLoading(false);
        }
      });

      // A real search failure reported by the server (bad city, DCAD outage...)
      sse.addEventListener('search_error', (e) => {
        finished = true;
        sse.close();
        if (!isCurrent()) return;
        let message = 'Search failed';
        try {
          message = JSON.parse((e as MessageEvent).data).error || message;
        } catch (_err) {
          /* keep default message */
        }
        failSearch(message);
      });

      // Connection-level problem. EventSource would otherwise silently reconnect and
      // restart the whole search, so always close it here.
      sse.addEventListener('error', () => {
        if (finished) return;
        sse.close();
        if (!isCurrent()) return;
        if (!receivedAnything) {
          // The stream never started: use the plain request instead.
          console.warn('SSE could not start, falling back to POST');
          fallbackPostSearch(params, searchId);
        } else {
          // The stream dropped part-way. Do not silently re-run the whole search.
          failSearch(
            'Lost the connection to the server part-way through the search. The lots listed so far are incomplete - please run the search again.'
          );
        }
      });
    } catch (err: any) {
      console.warn('Failed to start SSE, falling back to POST:', err);
      fallbackPostSearch(params, searchId);
    }
  };

  // Address import: look up specific addresses and show them exactly like street-search results
  const handleImport = async (params: { addresses: string[]; city: string }) => {
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
      eventSourceRef.current = null;
    }
    importAbortRef.current?.abort();
    const controller = new AbortController();
    importAbortRef.current = controller;

    const searchId = ++searchIdRef.current;
    const isCurrent = () => searchIdRef.current === searchId;

    setRecords([]);
    setActiveLotIndex(0);
    setIsLoading(true);
    setError(null);
    setWarnings([]);
    setImportSummary(null);
    setSearchParams({
      streetName: `Imported addresses (${params.addresses.length})`,
      city: params.city || 'Dallas County',
      zipFilter: '',
      maxResults: 0,
    });
    setProgress({
      stage: 'searching',
      message: `Matching ${params.addresses.length} imported addresses to DCAD parcels...`,
      percent: 5,
    });

    const failImport = (message: string) => {
      setError(message);
      setProgress({ stage: 'error', message, percent: 0 });
      setIsLoading(false);
    };

    try {
      const res = await fetch('/api/import/stream', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(params),
        signal: controller.signal,
      });
      if (!res.ok || !res.body) {
        throw new Error(
          res.status === 401 ? 'Password required.' : `Import failed to start (HTTP ${res.status}).`
        );
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let finished = false;

      const handleEvent = (event: string, raw: string) => {
        if (!isCurrent()) return;
        let data: any;
        try {
          data = JSON.parse(raw);
        } catch {
          return;
        }
        if (event === 'progress') {
          setProgress(data as SearchProgress);
        } else if (event === 'lot_found') {
          const lot = data as PropertyRecord;
          setRecords((prev) =>
            prev.some((r) => r.accountNumber === lot.accountNumber)
              ? prev.map((r) => (r.accountNumber === lot.accountNumber ? lot : r))
              : [...prev, lot]
          );
        } else if (event === 'done') {
          finished = true;
          if (data.results) setRecords(data.results);
          setWarnings(Array.isArray(data.warnings) ? data.warnings : []);
          setImportSummary(data.summary || null);
          setProgress({ stage: 'completed', message: 'Import completed successfully.', percent: 100 });
          setIsLoading(false);
        } else if (event === 'search_error') {
          finished = true;
          failImport(data.error || 'Import failed');
        }
      };

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let sep: number;
        while ((sep = buffer.indexOf('\n\n')) >= 0) {
          const block = buffer.slice(0, sep);
          buffer = buffer.slice(sep + 2);
          let event = 'message';
          const dataLines: string[] = [];
          for (const line of block.split('\n')) {
            if (line.startsWith('event:')) event = line.slice(6).trim();
            else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
          }
          if (dataLines.length) handleEvent(event, dataLines.join('\n'));
        }
      }

      if (!finished && isCurrent()) {
        failImport(
          'Lost the connection to the server part-way through the import. The lots listed so far are incomplete - please run the import again.'
        );
      }
    } catch (err: any) {
      if (err?.name === 'AbortError' || !isCurrent()) return;
      failImport(err?.message || 'Failed to complete import');
    }
  };

  const fallbackPostSearch = async (
    params: {
      streetName: string;
      city: string;
      zipFilter?: string;
      maxResults?: number;
    },
    searchId: number
  ) => {
    const isCurrent = () => searchIdRef.current === searchId;
    try {
      setProgress({
        stage: 'inspecting',
        message: 'Querying DCAD records via standard API...',
        percent: 50,
      });

      const res = await fetch('/api/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(params),
      });

      const data = await res.json();
      if (!isCurrent()) return;
      if (!res.ok || !data.success) {
        throw new Error(data.error || 'DCAD search failed');
      }

      setRecords(data.results || []);
      setWarnings(Array.isArray(data.warnings) ? data.warnings : []);
      setProgress({
        stage: 'completed',
        message: `Found ${data.count || 0} candidate vacant lots.`,
        percent: 100,
      });
    } catch (err: any) {
      if (!isCurrent()) return;
      setError(err.message || 'Failed to complete search');
      setProgress({
        stage: 'error',
        message: err.message || 'Error occurred during search',
        percent: 0,
      });
    } finally {
      if (isCurrent()) setIsLoading(false);
    }
  };

  const handleCancelSearch = () => {
    searchIdRef.current++; // ignore anything still in flight
    importAbortRef.current?.abort();
    importAbortRef.current = null;
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
      eventSourceRef.current = null;
    }
    setIsLoading(false);
    setProgress({
      stage: 'completed',
      message: 'Search stopped by user.',
      percent: 100,
    });
    setWarnings(['Search was stopped early - the list below is incomplete.']);
  };

  // Step 2 MapCheck verification actions
  const handleUpdateMapCheck = (
    accountNumber: string,
    status: MapCheckValue,
    notes?: string,
    mapLoadError?: boolean
  ) => {
    setRecords((prev) =>
      prev.map((r) =>
        r.accountNumber === accountNumber
          ? {
              ...r,
              mapCheck: status,
              manualChecked: true,
              mapCheckNotes: notes || r.mapCheckNotes,
              mapLoadError: mapLoadError !== undefined ? mapLoadError : r.mapLoadError,
            }
          : r
      )
    );
  };

  const handleSetAllUncheckedVacant = () => {
    setRecords((prev) =>
      prev.map((r) =>
        r.mapCheck === 'Pending MapCheck'
          ? {
              ...r,
              mapCheck: 'MapCheck - Vacant Lot' as const,
              manualChecked: true,
              mapCheckNotes: 'Batch-marked vacant from DCAD records (no individual aerial review)',
            }
          : r
      )
    );
  };

  const handleOpenMapVerification = (index: number) => {
    setActiveLotIndex(index);
    setIsMapModalOpen(true);
  };

  const handleRunAutoMapCheck = async () => {
    if (records.length === 0) return;
    setIsAutoChecking(true);
    try {
      const res = await fetch('/api/auto-mapcheck', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ lots: records.filter((r) => !r.manualChecked) }),
      });
      if (!res.ok) {
        throw new Error(`Records pre-screen failed (HTTP ${res.status})`);
      }
      const data = await res.json();
      if (data.results) {
        const resultMap = new Map<string, { mapCheck: MapCheckValue; explanation: string }>();
        for (const r of data.results) {
          resultMap.set(r.accountNumber, { mapCheck: r.mapCheck, explanation: r.explanation });
        }
        setRecords((prev) =>
          prev.map((lot) => {
            const match = resultMap.get(lot.accountNumber);
            // Never overwrite a status a person has already set
            if (match && !lot.manualChecked) {
              return {
                ...lot,
                mapCheck: match.mapCheck,
                mapCheckExplanation: match.explanation,
                autoChecked: true,
              };
            }
            return lot;
          })
        );
      }
    } catch (err) {
      console.error('Error running on-demand records pre-screen:', err);
      setWarnings((prev) => [...prev, 'The records pre-screen could not be run. Statuses were left unchanged.']);
    } finally {
      setIsAutoChecking(false);
    }
  };

  const vacantCheckLots = records.filter(
    (r) => r.mapCheck === 'MapCheck - Vacant Lot'
  );
  const structureLots = records.filter(
    (r) => r.mapCheck === 'MapCheck - Had Structures'
  );
  const unclearLots = records.filter(
    (r) => r.mapCheck === 'MapCheck - Unclear'
  );
  const pendingLots = records.filter(
    (r) => r.mapCheck === 'Pending MapCheck'
  );

  return (
    <div className="min-h-screen bg-slate-100 flex flex-col font-sans text-slate-900">
      <Header />

      <main className="flex-1 max-w-7xl w-full mx-auto px-4 sm:px-6 lg:px-8 py-6">
        {/* INPUTS - Displayed as the FIRST thing on the page per instructions */}
        <SearchForm
          cities={cities}
          isLoading={isLoading}
          onSearch={handleSearch}
          onCancel={handleCancelSearch}
          onImport={handleImport}
        />

        {/* Live Progress Indicator */}
        <ProgressIndicator
          progress={progress}
          totalFound={records.length}
          vacantFound={records.length}
        />

        {/* Error notification if any */}
        {error && (
          <div className="mb-6 p-4 rounded-xl bg-rose-50 border border-rose-200 text-rose-800 text-sm flex items-start gap-2.5">
            <AlertCircle className="w-5 h-5 text-rose-600 shrink-0 mt-0.5" />
            <div>
              <p className="font-semibold">Unable to complete DCAD query</p>
              <p className="text-xs text-rose-700 mt-0.5">{error}</p>
            </div>
          </div>
        )}

        {/* Non-fatal warnings: partial results, scan limit, DCAD outages */}
        {warnings.length > 0 && (
          <div className="mb-6 p-4 rounded-xl bg-amber-50 border border-amber-300 text-amber-900 text-sm flex items-start gap-2.5">
            <AlertCircle className="w-5 h-5 text-amber-600 shrink-0 mt-0.5" />
            <div>
              <p className="font-semibold">These results may be incomplete</p>
              <ul className="text-xs text-amber-800 mt-1 list-disc pl-4 space-y-0.5">
                {warnings.map((w, i) => (
                  <li key={i}>{w}</li>
                ))}
              </ul>
            </div>
          </div>
        )}

        {/* Address import summary: addresses that did not become candidate vacant lots */}
        {importSummary && !isLoading && (
          <div className="mb-6 p-4 rounded-xl bg-sky-50 border border-sky-200 text-sky-900 text-sm">
            <p className="font-semibold">
              Import summary: {importSummary.requested} address{importSummary.requested === 1 ? '' : 'es'} checked •{' '}
              {importSummary.matched} matched to DCAD • {records.length} candidate vacant lot{records.length === 1 ? '' : 's'}
            </p>
            {importSummary.notFound.length > 0 && (
              <details className="mt-2" open={importSummary.notFound.length <= 5}>
                <summary className="text-xs font-semibold text-sky-800 cursor-pointer">
                  {importSummary.notFound.length} not found
                </summary>
                <ul className="text-xs text-sky-900 mt-1 list-disc pl-5 space-y-0.5">
                  {importSummary.notFound.map((n, i) => (
                    <li key={i}>
                      <span className="font-mono">{n.input}</span> - {n.reason}
                    </li>
                  ))}
                </ul>
              </details>
            )}
            {importSummary.notVacant.length > 0 && (
              <details className="mt-2" open={importSummary.notVacant.length <= 5}>
                <summary className="text-xs font-semibold text-sky-800 cursor-pointer">
                  {importSummary.notVacant.length} matched but not vacant candidates
                </summary>
                <ul className="text-xs text-sky-900 mt-1 list-disc pl-5 space-y-0.5">
                  {importSummary.notVacant.map((n, i) => (
                    <li key={i}>
                      <a href={n.dcadLink} target="_blank" rel="noreferrer" className="font-mono underline">
                        {n.address || n.input}
                      </a>{' '}
                      ({n.accountNumber}) - {n.reason}
                    </li>
                  ))}
                </ul>
              </details>
            )}
          </div>
        )}

        {/* Workflow Overview Banner */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-6 text-xs">
          <div className="p-3.5 bg-white rounded-xl border border-slate-200 shadow-xs flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-blue-100 text-blue-700 flex items-center justify-center font-bold text-xs shrink-0">
              1
            </div>
            <div>
              <div className="font-semibold text-slate-900">STEP 1: Pull All Results, All Pages</div>
              <div className="text-slate-500 text-[11px]">
                Searches SearchAddr.aspx (all pages) &amp; inspects detail pages for $0 improvement value.
              </div>
            </div>
          </div>

          <div className="p-3.5 bg-white rounded-xl border border-slate-200 shadow-xs flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-emerald-100 text-emerald-700 flex items-center justify-center font-bold text-xs shrink-0">
              2
            </div>
            <div>
              <div className="font-semibold text-slate-900">STEP 2: Manually Verify Each on 2026 Map</div>
              <div className="text-slate-500 text-[11px]">
                Switch DCAD map to 2026 Hybrid, check aerial imagery, and assign exact MapCheck values.
              </div>
            </div>
          </div>
        </div>

        {/* Step 2 MapCheck Quick Action Banner */}
        {records.length > 0 && (
          <div className="mb-6 p-4 rounded-xl bg-gradient-to-r from-emerald-900 to-slate-900 text-white shadow-md flex flex-col md:flex-row md:items-center md:justify-between gap-4">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-xl bg-emerald-500/20 border border-emerald-500/40 flex items-center justify-center text-emerald-400 shrink-0">
                <Layers className="w-5 h-5" />
              </div>
              <div>
                <h3 className="text-sm font-bold text-white flex items-center gap-2">
                  <span>Found {records.length} Candidate Vacant Lots {importSummary ? 'from' : 'on'} {searchParams.streetName}</span>
                  <span className="px-2 py-0.5 rounded text-[10px] font-semibold bg-emerald-500/20 text-emerald-300 border border-emerald-500/30">
                    Step 1 Complete
                  </span>
                </h3>
                <p className="text-xs text-slate-300 mt-0.5">
                  {vacantCheckLots.length} confirmed vacant • {structureLots.length} had structures • {unclearLots.length} unclear • {pendingLots.length} pending MapCheck
                </p>
              </div>
            </div>

            <div className="flex items-center gap-2">
              <button
                onClick={() => handleOpenMapVerification(0)}
                className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-bold text-xs shadow-sm transition-colors cursor-pointer"
              >
                <Eye className="w-4 h-4" />
                <span>Launch 2026 MapCheck Viewer</span>
              </button>

              {pendingLots.length > 0 && (
                <button
                  onClick={handleSetAllUncheckedVacant}
                  className="inline-flex items-center gap-1 px-3 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-white font-medium text-xs border border-slate-700 transition-colors cursor-pointer"
                  title="Mark all pending as MapCheck - Vacant Lot"
                >
                  <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />
                  <span className="hidden sm:inline">Mark Rest Vacant</span>
                </button>
              )}
            </div>
          </div>
        )}

        {/* Output: Results Table with exact required columns:
            Address, City, Zip, Account Number, DCAD Link, Map Link, MapCheck */}
        <ResultsTable
          records={records}
          onOpenMapVerification={handleOpenMapVerification}
          onUpdateMapCheck={handleUpdateMapCheck}
          onRunAutoMapCheck={handleRunAutoMapCheck}
          isAutoChecking={isAutoChecking}
          onExportCSV={() => setIsExportModalOpen(true)}
          onExportGoogleSheets={() => setIsExportModalOpen(true)}
          onSetAllUncheckedVacant={handleSetAllUncheckedVacant}
          activeZipFilter={searchParams.zipFilter}
          onZipFilterChange={(zip) => setSearchParams((prev) => ({ ...prev, zipFilter: zip }))}
        />
      </main>

      {/* Visual Verification Modal with Embedded DCAD 2026 Property Map Viewer */}
      <VisualVerificationModal
        lots={records}
        currentIndex={activeLotIndex}
        isOpen={isMapModalOpen}
        onClose={() => setIsMapModalOpen(false)}
        onSetMapCheck={handleUpdateMapCheck}
        onSelectIndex={setActiveLotIndex}
        onSetAllUncheckedVacant={handleSetAllUncheckedVacant}
      />

      {/* Export Modal with CSV & Google Sheets Options */}
      <ExportModal
        isOpen={isExportModalOpen}
        onClose={() => setIsExportModalOpen(false)}
        records={records}
        streetName={searchParams.streetName}
        city={searchParams.city}
      />
    </div>
  );
}

