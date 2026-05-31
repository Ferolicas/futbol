// AF1 FIX: lectura ÚNICA y null-safe de stats de API-Football, compartida por el
// lado web (lib/api-football.js fetchMatchStats + app/api/refresh-live). Replica
// la lógica correcta del worker (jobs/futbol/live.js statLookup):
//   - Aliases por liga: "Corner Kicks" | "Corners" | "Corner", etc.
//   - value puede llegar como null, string "null" o "" → devolvemos null (NO 0),
//     para distinguir "la API no reporta" de "el evento no ocurrió (0 real)".
// Antes estos dos caminos hacían `stat?.value || 0` (sin aliases, null→0) → datos
// inconsistentes vs el worker.
export function statLookup(teamStats, ...candidates) {
  const arr = teamStats?.statistics;
  if (!Array.isArray(arr) || arr.length === 0) return null;
  const norm = (s) => (s || '').toString().toLowerCase().replace(/\s+/g, ' ').trim();
  const wanted = candidates.map(norm);
  for (const s of arr) {
    if (wanted.includes(norm(s.type))) {
      const v = s.value;
      if (v === null || v === undefined || v === 'null' || v === '') return null;
      const n = typeof v === 'number' ? v : Number(v);
      return Number.isFinite(n) ? n : null;
    }
  }
  return null;
}

// Aliases canónicos por métrica (mismos que usa el worker).
export const STAT_ALIASES = {
  corners: ['Corner Kicks', 'Corners', 'Corner'],
  yellow: ['Yellow Cards', 'Yellowcards'],
  red: ['Red Cards', 'Redcards'],
  shots: ['Total Shots', 'Shots Total'],
  sot: ['Shots on Goal', 'Shots on Target'],
  fouls: ['Fouls', 'Fouls Committed'],
  offsides: ['Offsides', 'Offside'],
};
