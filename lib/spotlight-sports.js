export function toggleSpotlightSport(selectedSports, sport) {
  const current = Array.isArray(selectedSports) ? selectedSports : [];
  if (!sport) return current;
  return current.includes(sport)
    ? current.filter((selected) => selected !== sport)
    : [...current, sport];
}
