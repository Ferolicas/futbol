// Nombre legible en español por market_key. PURO (sin dependencias) → usable en
// servidor (context-probabilities, al armar la combinada) y en cliente (dashboard,
// para traducir claves crudas que vengan de caché vieja). [Local]/[Visitante] →
// nombres reales de equipo.
export function marketLabel(key, teamNames) {
  const H = teamNames?.home || 'Local', A = teamNames?.away || 'Visitante';
  // ── Over/Under (total y por equipo, full y por mitad) ──
  const ou = key.match(/^(.+)_(over|under)(\d+)_5$/);
  if (ou) {
    const line = `${ou[3]}.5`, dir = ou[2] === 'over' ? 'Más de' : 'Menos de';
    const F = {
      total_goals: ['Total partido', 'goles'], total_corners: ['Total partido', 'córners'], total_cards: ['Total partido', 'tarjetas'],
      total_shots: ['Total partido', 'tiros'], total_sot: ['Total partido', 'tiros a puerta'], total_fouls: ['Total partido', 'faltas'],
      total_offsides: ['Total partido', 'offsides'],
      home_goals: [H, 'goles'], away_goals: [A, 'goles'], home_corners: [H, 'córners'], away_corners: [A, 'córners'],
      home_cards: [H, 'tarjetas'], away_cards: [A, 'tarjetas'], home_shots: [H, 'tiros'], away_shots: [A, 'tiros'],
      home_fouls: [H, 'faltas'], away_fouls: [A, 'faltas'], home_offsides: [H, 'offsides'], away_offsides: [A, 'offsides'],
      total_goals_1h: ['1ª Parte', 'goles'], total_goals_2h: ['2ª Parte', 'goles'],
      total_cards_1h: ['1ª Parte', 'tarjetas'], total_cards_2h: ['2ª Parte', 'tarjetas'],
      total_corners_1h: ['1ª Parte', 'córners'], total_corners_2h: ['2ª Parte', 'córners'],
      total_shots_1h: ['1ª Parte', 'tiros'], total_shots_2h: ['2ª Parte', 'tiros'],
      total_sot_1h: ['1ª Parte', 'tiros a puerta'], total_sot_2h: ['2ª Parte', 'tiros a puerta'],
      total_fouls_1h: ['1ª Parte', 'faltas'], total_fouls_2h: ['2ª Parte', 'faltas'],
      home_goals_1h: [`${H} 1ª Parte`, 'goles'], away_goals_1h: [`${A} 1ª Parte`, 'goles'],
      home_goals_2h: [`${H} 2ª Parte`, 'goles'], away_goals_2h: [`${A} 2ª Parte`, 'goles'],
      home_corners_1h: [`${H} 1ª Parte`, 'córners'], away_corners_1h: [`${A} 1ª Parte`, 'córners'],
      home_corners_2h: [`${H} 2ª Parte`, 'córners'], away_corners_2h: [`${A} 2ª Parte`, 'córners'],
    }[ou[1]];
    return F ? `${F[0]} — ${dir} ${line} ${F[1]}` : `${ou[1]} — ${dir} ${line}`;
  }
  // ── Hándicap asiático ──
  const ah = key.match(/^ah_(home|away)_([mp])(\d+)_(\d+)$/);
  if (ah) {
    const team = ah[1] === 'home' ? H : A;
    return `${team} — Hándicap asiático ${ah[2] === 'm' ? '-' : '+'}${ah[3]}.${ah[4]}`;
  }
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
