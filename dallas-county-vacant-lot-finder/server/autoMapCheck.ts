import type { PropertyRecord, MapCheckValue } from '../src/types/property.js';

/**
 * DCAD records pre-screen.
 *
 * IMPORTANT: this does NOT look at any aerial imagery. It only re-reads the appraisal
 * fields DCAD publishes (improvement value, building area, year built, class/use).
 *
 * It can therefore do exactly two honest things:
 *   - flag a lot as "Had Structures" when DCAD's own records show a building, or
 *   - leave it "Pending MapCheck" so a person confirms it on the aerial.
 *
 * It never returns "MapCheck - Vacant Lot": that status means someone looked at the map.
 * (Previously this function stamped every $0-improvement lot as map-verified vacant.)
 */
export async function runAutoMapCheck(lot: PropertyRecord): Promise<{
  mapCheck: MapCheckValue;
  explanation: string;
  confidence: number;
}> {
  const impIsNA = lot.improvementValueDisplay === 'N/A';
  const impValue = Number(lot.improvementValue) || 0;
  const hasImprovementValue = impValue > 0 && !impIsNA;
  const bldgArea = Number(lot.buildingArea) || 0;
  const yearBuilt = Number(lot.yearBuilt) || 0;
  const classVacant = (lot.propertyClass || '').toUpperCase().includes('VACANT');
  const useVacant = (lot.useDescription || '').toUpperCase().includes('VACANT');

  if (hasImprovementValue || bldgArea > 0) {
    const reasons: string[] = [];
    if (hasImprovementValue) reasons.push(`assessed improvements of $${impValue.toLocaleString()}`);
    if (bldgArea > 0) reasons.push(`a recorded building area of ${bldgArea.toLocaleString()} sq ft`);
    return {
      mapCheck: 'MapCheck - Had Structures',
      explanation: `Records pre-screen: DCAD shows ${reasons.join(' and ')}. Aerial not reviewed.`,
      confidence: 0.9,
    };
  }

  const impLabel = impIsNA ? 'N/A' : '$0';
  const supporting: string[] = [`${impLabel} improvement value`, 'no building area on record'];
  if (classVacant || useVacant) supporting.push('classified vacant');
  if (yearBuilt > 0) supporting.push(`but a year built of ${yearBuilt} is on record (possible demolition)`);

  return {
    mapCheck: 'Pending MapCheck',
    explanation: `Records pre-screen: ${supporting.join(', ')}. Needs aerial review to confirm.`,
    confidence: yearBuilt > 0 ? 0.6 : 0.8,
  };
}
