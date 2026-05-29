// Nombre legible en español por market_key. PURO (sin dependencias) → usable en
// servidor (context-probabilities, al armar la combinada) y en cliente (dashboard,
// para traducir claves crudas que vengan de caché vieja). [Local]/[Visitante] →
// nombres reales de equipo.
// Naturaleza EXACTA de cada métrica, distinguiendo total partido vs por equipo.
// Por equipo: faltas COMETIDAS, tarjetas RECIBIDAS, córners A FAVOR, etc. → la
// etiqueta nunca es ambigua sobre qué mide.
const METRIC_NATURE = {
  goals:       { total: 'Goles',            team: 'Goles a favor' },
  corners:     { total: 'Córners',          team: 'Córners a favor' },
  cards:       { total: 'Tarjetas',         team: 'Tarjetas recibidas' },
  shots:       { total: 'Remates totales',  team: 'Remates totales' },
  shots_on:    { total: 'Remates a puerta', team: 'Remates a puerta' },
  sot:         { total: 'Remates a puerta', team: 'Remates a puerta' },
  fouls:       { total: 'Faltas',           team: 'Faltas cometidas' },
  fouls_drawn: { total: 'Faltas recibidas', team: 'Faltas recibidas' },
  offsides:    { total: 'Fueras de juego',  team: 'Fueras de juego' },
};

export function marketLabel(key, teamNames) {
  const H = teamNames?.home || 'Local', A = teamNames?.away || 'Visitante';
  // ── Over/Under (total y por equipo, full y por mitad) ──
  const ou = key.match(/^(.+)_(over|under)(\d+)_5$/);
  if (ou) {
    const line = `${ou[3]}.5`, dir = ou[2] === 'over' ? 'Más de' : 'Menos de';
    // Descompone la base en lado (total/home/away) + métrica + mitad.
    const dec = ou[1].match(/^(total|home|away)_(goals|corners|cards|shots_on|shots|sot|fouls_drawn|fouls|offsides)(?:_(1h|2h))?$/);
    if (dec) {
      const [, sideKey, metric, half] = dec;
      const nat = METRIC_NATURE[metric];
      const nature = nat ? nat[sideKey === 'total' ? 'total' : 'team'] : metric;
      let subject = sideKey === 'total' ? 'Total partido' : (sideKey === 'home' ? H : A);
      if (half) subject += ` · ${half === '1h' ? '1ª Parte' : '2ª Parte'}`;
      return `${subject} — ${nature} — ${dir} ${line}`;
    }
    return `${ou[1]} — ${dir} ${line}`;
  }
  // (Hándicap asiático eliminado del catálogo.)
  // ── Escalares ──
  const S = {
    home_win: `Ganador — ${H}`, draw: 'Empate', away_win: `Ganador — ${A}`,
    btts: 'Ambos equipos marcan', btts_no: 'Ambos equipos NO marcan',
    first_goal_30: 'Primer gol antes del minuto 30', first_goal_45: 'Primer gol antes del minuto 45',
    winner_1h_home: `1ª Parte — Gana ${H}`, winner_1h_draw: '1ª Parte — Empate', winner_1h_away: `1ª Parte — Gana ${A}`,
    winner_2h_home: `2ª Parte — Gana ${H}`, winner_2h_draw: '2ª Parte — Empate', winner_2h_away: `2ª Parte — Gana ${A}`,
    most_corners_home: `Más córners — ${H}`, most_corners_draw: 'Mismos córners (empate)', most_corners_away: `Más córners — ${A}`,
    most_corners_1h_home: `1ª Parte — Más córners ${H}`, most_corners_1h_draw: '1ª Parte — Empate de córners', most_corners_1h_away: `1ª Parte — Más córners ${A}`,
    most_corners_2h_home: `2ª Parte — Más córners ${H}`, most_corners_2h_draw: '2ª Parte — Empate de córners', most_corners_2h_away: `2ª Parte — Más córners ${A}`,
    most_shots_home: `Más tiros — ${H}`, most_shots_draw: 'Mismos tiros (empate)', most_shots_away: `Más tiros — ${A}`,
    most_fouls_home: `Más faltas — ${H}`, most_fouls_draw: 'Mismas faltas (empate)', most_fouls_away: `Más faltas — ${A}`,
    red_card_any: 'Total partido — Habrá tarjeta roja', red_card_home: `${H} — Tarjeta roja`, red_card_away: `${A} — Tarjeta roja`,
    goal_0_15: 'Gol entre el min 1 y 15', goal_16_30: 'Gol entre el min 16 y 30', goal_31_45: 'Gol entre el min 31 y 45',
    goal_46_60: 'Gol entre el min 46 y 60', goal_61_75: 'Gol entre el min 61 y 75', goal_76_90: 'Gol del min 76 en adelante',
  };
  return S[key] || key;
}

// ¿Una cadena parece un market_key crudo (no un nombre legible)? Para decidir si
// hay que traducir una selección que viene de caché vieja.
export function looksLikeMarketKey(s) {
  return typeof s === 'string' && /^[a-z][a-z0-9_]*$/.test(s);
}
