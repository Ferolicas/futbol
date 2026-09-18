export function probabilityLineItems(probObj, oddObj, namePrefix = '') {
  if (!probObj || typeof probObj !== 'object') return [];
  const lines = Array.isArray(probObj._lines)
    ? probObj._lines
    : [...new Set(Object.keys(probObj).flatMap(key => {
        const match = key.match(/^(?:over|under)(\d+)(?:_(\d+))?$/i);
        if (!match) return [];
        return [match[2] ? Number(`${match[1]}.${match[2]}`) : Number(match[1]) / 10];
      }))];

  const valueFor = (direction, line) => {
    const normalized = String(line).replace('.', '_');
    const legacy = String(Math.round(Number(line) * 10)).padStart(2, '0');
    return probObj[`${direction}${normalized}`] ?? probObj[`${direction}${legacy}`];
  };
  const oddFor = (direction, line) => {
    const key = `${direction === 'over' ? 'Over' : 'Under'}_${String(line).replace('.', '_')}`;
    const value = Number(oddObj?.[key]);
    return Number.isFinite(value) && value > 1 ? value : null;
  };

  return lines
    .map(Number)
    .filter(Number.isFinite)
    .sort((a, b) => a - b)
    .flatMap(line => ([
      { label: `${namePrefix}Más de ${line}`.trim(), value: valueFor('over', line), odd: oddFor('over', line) },
      { label: `${namePrefix}Menos de ${line}`.trim(), value: valueFor('under', line), odd: oddFor('under', line) },
    ]))
    .filter(item => Number.isFinite(Number(item.value)));
}

export function buildFootballProbabilityGroups(p, odds, homeTeam, awayTeam) {
  if (!p) return [];
  const o = odds || {};
  const withOdd = (label, value, odd) => Number.isFinite(Number(value))
    ? { label, value, odd: Number(odd) > 1 ? Number(odd) : null }
    : null;
  const choices = (probObj, oddObj, labels) => labels.map(([key, label]) => (
    withOdd(label, probObj?.[key], oddObj?.[key])
  )).filter(Boolean);

  return [
    { title: 'Ambos marcan', group: 'goles', items: [
      withOdd('Sí', p.btts, o.btts?.yes),
      withOdd('No', p.bttsNo, o.btts?.no),
    ].filter(Boolean) },
    { title: 'Ganador', group: 'goles', items: choices(p.winner, o.matchWinner, [
      ['home', homeTeam], ['draw', 'Empate'], ['away', awayTeam],
    ]) },
    { title: 'Goles totales', group: 'goles', subtitle: p.overUnder?.expectedTotal != null ? `Media anotadora combinada: ${p.overUnder.expectedTotal} goles por partido` : null, items: probabilityLineItems(p.overUnder, o.overUnder) },
    { title: 'Goles 1ª parte', group: 'goles', items: probabilityLineItems(p.halfGoals?.firstHalf, o.goals1H) },
    { title: 'Goles 2ª parte', group: 'goles', items: probabilityLineItems(p.halfGoals?.secondHalf, o.goals2H) },
    { title: 'Ganador 1ª parte', group: 'goles', items: choices(p.halfWinner?.firstHalf, o.winner1H, [
      ['home', homeTeam], ['draw', 'Empate'], ['away', awayTeam],
    ]) },
    { title: 'Ganador 2ª parte', group: 'goles', items: choices(p.halfWinner?.secondHalf, o.winner2H, [
      ['home', homeTeam], ['draw', 'Empate'], ['away', awayTeam],
    ]) },
    { title: `Goles — ${homeTeam}`, group: 'goles', items: probabilityLineItems(p.perTeam?.home?.goals, o.homeGoals) },
    { title: `Goles — ${awayTeam}`, group: 'goles', items: probabilityLineItems(p.perTeam?.away?.goals, o.awayGoals) },
    { title: `Goles 1ª parte — ${homeTeam}`, group: 'goles', items: probabilityLineItems(p.perTeamHalfGoals?.home?.firstHalf, o.homeGoals1H) },
    { title: `Goles 1ª parte — ${awayTeam}`, group: 'goles', items: probabilityLineItems(p.perTeamHalfGoals?.away?.firstHalf, o.awayGoals1H) },
    { title: `Goles 2ª parte — ${homeTeam}`, group: 'goles', items: probabilityLineItems(p.perTeamHalfGoals?.home?.secondHalf, o.homeGoals2H) },
    { title: `Goles 2ª parte — ${awayTeam}`, group: 'goles', items: probabilityLineItems(p.perTeamHalfGoals?.away?.secondHalf, o.awayGoals2H) },

    { title: 'Córners totales', group: 'corners', items: probabilityLineItems(p.corners, o.corners) },
    { title: `Córners — ${homeTeam}`, group: 'corners', items: probabilityLineItems(p.perTeam?.home?.corners, o.homeCorners) },
    { title: `Córners — ${awayTeam}`, group: 'corners', items: probabilityLineItems(p.perTeam?.away?.corners, o.awayCorners) },
    { title: 'Más córners — partido', group: 'corners', items: choices(p.mostCorners?.fullMatch, o.corners1x2, [
      ['home', homeTeam], ['draw', 'Empate'], ['away', awayTeam],
    ]) },
    { title: 'Más córners — 1ª parte', group: 'corners', items: choices(p.mostCorners?.firstHalf, o.corners1x21H, [
      ['home', homeTeam], ['draw', 'Empate'], ['away', awayTeam],
    ]) },
    { title: 'Más córners — 2ª parte', group: 'corners', items: choices(p.mostCorners?.secondHalf, o.corners1x22H, [
      ['home', homeTeam], ['draw', 'Empate'], ['away', awayTeam],
    ]) },

    { title: 'Tarjetas totales', group: 'tarjetas', items: probabilityLineItems(p.cards, o.cards) },
    { title: `Tarjetas — ${homeTeam}`, group: 'tarjetas', items: probabilityLineItems(p.perTeam?.home?.cards, o.homeCards) },
    { title: `Tarjetas — ${awayTeam}`, group: 'tarjetas', items: probabilityLineItems(p.perTeam?.away?.cards, o.awayCards) },
    { title: 'Tarjetas rojas', group: 'tarjetas', items: [withOdd('Habrá tarjeta roja', p.redCards?.anyRed, o.redCards?.yes)].filter(Boolean) },

    { title: 'Remates totales', group: 'tiros', subtitle: p.shots?._mean ? `Media observada: ${p.shots._mean}` : null, items: probabilityLineItems(p.shots, o.shots) },
    { title: 'Remates a puerta', group: 'tiros', subtitle: p.sot?._mean ? `Media observada: ${p.sot._mean}` : null, items: probabilityLineItems(p.sot, o.sot) },
    { title: `Remates — ${homeTeam}`, group: 'tiros', items: probabilityLineItems(p.perTeamShots?.home, o.homeShots) },
    { title: `Remates — ${awayTeam}`, group: 'tiros', items: probabilityLineItems(p.perTeamShots?.away, o.awayShots) },
    { title: 'Más remates', group: 'tiros', items: choices(p.mostShots?.fullMatch, o.shots1x2, [
      ['home', homeTeam], ['draw', 'Empate'], ['away', awayTeam],
    ]) },

    { title: 'Faltas totales', group: 'faltas', subtitle: p.fouls?._mean ? `Media observada: ${p.fouls._mean}` : null, items: probabilityLineItems(p.fouls, o.fouls) },
    { title: `Faltas — ${homeTeam}`, group: 'faltas', items: probabilityLineItems(p.perTeamFouls?.home, o.homeFouls) },
    { title: `Faltas — ${awayTeam}`, group: 'faltas', items: probabilityLineItems(p.perTeamFouls?.away, o.awayFouls) },
    { title: 'Más faltas', group: 'faltas', items: choices(p.mostFouls?.fullMatch, o.fouls1x2, [
      ['home', homeTeam], ['draw', 'Empate'], ['away', awayTeam],
    ]) },

    { title: 'Fueras de juego totales', group: 'offsides', items: probabilityLineItems(p.offsides, o.offsides) },
    { title: `Fueras de juego — ${homeTeam}`, group: 'offsides', items: probabilityLineItems(p.perTeamOffsides?.home, o.homeOffsides) },
    { title: `Fueras de juego — ${awayTeam}`, group: 'offsides', items: probabilityLineItems(p.perTeamOffsides?.away, o.awayOffsides) },
  ].filter(group => Array.isArray(group.items) && group.items.length > 0);
}
