// Compact display tree for the dashboard. Full evidence stays in the detail
// endpoint; Free callers never receive this tree.
export function displayProbabilities(value) {
  if (!value) return null;
  const prediction = value.evidence || value;
  const compact = item => {
    if (item == null || typeof item !== 'object') return item;
    if (Array.isArray(item)) return item.map(compact);
    return Object.fromEntries(Object.entries(item)
      .filter(([key]) => !['evidence', 'engine', 'players', 'pitchers', 'history', 'chain', 'samples'].includes(key))
      .map(([key, child]) => [key, compact(child)]));
  };
  return compact(prediction);
}
