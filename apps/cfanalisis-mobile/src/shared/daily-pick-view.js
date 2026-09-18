export function resolveDailyPickView(preferredView, upcomingCount, resultCount) {
  const hasUpcoming = Number(upcomingCount) > 0;
  const hasResults = Number(resultCount) > 0;

  // Nunca dejamos al usuario frente a una tira vacía si la otra vista sí tiene
  // contenido. Al comenzar la última apuesta, Resultados pasa a ser la vista
  // activa de inmediato y permanece presionada durante el cierre de la jornada.
  if (!hasUpcoming && hasResults) return 'results';
  if (!hasResults) return 'picks';
  return preferredView === 'results' ? 'results' : 'picks';
}
