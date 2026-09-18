// Filtro visual de ligas del dashboard.
// `null` significa "todas"; `[]` significa "ninguna". Mantener esa diferencia
// es imprescindible para persistir exactamente lo que eligió el usuario.

export function normalizeLeagueSelection(value) {
  if (value === null) return null;
  if (!Array.isArray(value)) return [];
  return [...new Set(
    value
      .map((id) => String(id ?? '').trim())
      .filter(Boolean),
  )];
}

export function leagueSelectionIncludes(selection, leagueId) {
  const normalized = normalizeLeagueSelection(selection);
  if (normalized === null) return true;
  return normalized.includes(String(leagueId ?? ''));
}

export function toggleLeagueSelection(selection, leagueId, allKnownIds = []) {
  const id = String(leagueId ?? '').trim();
  if (!id) return normalizeLeagueSelection(selection);

  const normalized = normalizeLeagueSelection(selection);
  const base = normalized === null
    ? normalizeLeagueSelection(allKnownIds) || []
    : normalized;
  const next = new Set(base);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  return [...next];
}
