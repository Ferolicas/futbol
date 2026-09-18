const cleanText = (value) => (typeof value === 'string'
  ? value.trim().replace(/\s+/g, ' ')
  : '');

function teamName(team) {
  if (typeof team === 'string') return cleanText(team);
  return cleanText(team?.name);
}

export function savedSelectionMatchName(selection, fallbackIndex = 0) {
  const explicitName = cleanText(
    selection?.matchName
    || selection?.match_name
    || selection?.match,
  );
  if (explicitName) return explicitName;

  const home = cleanText(selection?.homeTeam || selection?.home_team)
    || teamName(selection?.teams?.home);
  const away = cleanText(selection?.awayTeam || selection?.away_team)
    || teamName(selection?.teams?.away);
  if (home && away) return `${home} vs ${away}`;

  const fixtureId = cleanText(String(selection?.fixtureId || selection?.fixture_id || ''));
  if (fixtureId) return `Partido ${fixtureId}`;

  return `Partido guardado ${fallbackIndex + 1}`;
}

export function groupSavedCombinadaSelections(selections) {
  if (!Array.isArray(selections)) return [];

  const groups = new Map();
  selections.forEach((selection, index) => {
    const matchName = savedSelectionMatchName(selection, index);
    const fixtureId = cleanText(String(selection?.fixtureId || selection?.fixture_id || ''));
    const key = fixtureId
      ? `fixture:${fixtureId}`
      : `match:${matchName.toLocaleLowerCase('es')}`;

    if (!groups.has(key)) {
      groups.set(key, { key, fixtureId, matchName, selections: [] });
    }
    groups.get(key).selections.push(selection);
  });

  return Array.from(groups.values());
}
