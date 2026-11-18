// Region name in the data -> the feature name the vendored GeoJSON uses.
//
// The map file (public/geo/th-provinces.json) names each area in English. When the data uses
// other spellings or aliases, add them to ALIASES; names that already match pass through as-is.
export const ALIASES: Record<string, string> = {
  'Bangkok': 'Bangkok Metropolis',
  'Ayutthaya': 'Phra Nakhon Si Ayutthaya',
};

/** Data spelling -> GeoJSON name (aliases only; exact matches need no entry). */
export const TH_EN: Record<string, string> = ALIASES;

/** GeoJSON name -> display label. Empty by default, so the GeoJSON name is shown. */
export const EN_TH: Record<string, string> = {};

/**
 * Data label -> GeoJSON feature name, or null when the label is blank.
 *
 * Labels with no matching feature simply shade nothing on the map, rather than attaching their
 * values to some other area.
 */
export function provinceEn(name: string | null | undefined): string | null {
  if (!name) return null;
  const n = String(name).trim().replace(/^Province of\s*/i, "");
  if (!n) return null;
  return ALIASES[n] ?? n;
}
