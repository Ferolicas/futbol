export const MAX_BASEBALL_ANALYSIS_FIXTURES = 500;

export function normalizeBaseballAnalysisFixtureIds(fixtures, max = MAX_BASEBALL_ANALYSIS_FIXTURES) {
  const all = [...new Set((Array.isArray(fixtures) ? fixtures : [])
    .map((fixture) => String(fixture?.id || ''))
    .filter((fixtureId) => /^\d+$/.test(fixtureId)))];
  return {
    fixtureIds: all.slice(0, max),
    total: all.length,
    tooMany: all.length > max,
    max,
  };
}
