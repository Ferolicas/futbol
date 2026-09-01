const PERIOD_LABELS = Object.freeze({
  match: 'Partido completo', full: 'Partido completo', firstHalf: '1.ª parte', secondHalf: '2.ª parte',
  quarter1: '1.er cuarto', quarter2: '2.º cuarto', quarter3: '3.er cuarto', quarter4: '4.º cuarto',
  first3: 'Primeras 3 entradas', first4_5: 'Primeras 4,5 entradas', first5: 'Primeras 5 entradas',
  first7: 'Primeras 7 entradas',
});

const METRIC_LABELS = Object.freeze({
  goals: 'Goles', cards: 'Tarjetas', corners: 'Córners', shots: 'Remates', sot: 'Remates a puerta',
});

const fmt = (value) => value == null || !Number.isFinite(Number(value)) ? '—' : Number(value).toFixed(2);
const pct = (value) => value == null || !Number.isFinite(Number(value)) ? '—' : `${Math.min(95, Number(value)).toFixed(2).replace(/\.00$/, '')}%`;

function ExpectedRows({ verdict, homeName, awayName }) {
  const rows = [];
  const expected = verdict?.expected || {};
  if (expected.match) rows.push({ period: 'match', metric: 'Puntos/carreras', ...expected.match });
  for (const [period, value] of Object.entries(expected.periods || {})) {
    if (value && Object.values(value).some((item) => item != null)) rows.push({ period, metric: 'Puntos/carreras', ...value });
  }
  for (const period of ['full', 'firstHalf', 'secondHalf']) {
    for (const [metric, value] of Object.entries(expected[period] || {})) {
      if (value && Object.values(value).some((item) => item != null)) rows.push({ period, metric: METRIC_LABELS[metric] || metric, ...value });
    }
  }
  if (!rows.length) return null;
  return (
    <div className="final-verdict-expected">
      {rows.map((row) => (
        <article key={`${row.period}-${row.metric}`}>
          <small>{PERIOD_LABELS[row.period] || row.period} · {row.metric}</small>
          <div><span>{homeName}<b>{fmt(row.home)}</b></span><span>Total<b>{fmt(row.total)}</b></span><span>{awayName}<b>{fmt(row.away)}</b></span></div>
        </article>
      ))}
    </div>
  );
}

export default function FinalVerdictPanel({ verdict, homeName = 'Local', awayName = 'Visitante', compact = false }) {
  const picks = Array.isArray(verdict?.picks) ? verdict.picks : [];
  const h2h = Array.isArray(verdict?.h2h) ? verdict.h2h.slice(0, 2) : [];
  return (
    <section className={`final-verdict-panel ${compact ? 'is-compact' : ''}`}>
      <div className="final-verdict-heading">
        <span><small>PRONÓSTICO AISLADO</small><strong>Veredicto final</strong></span>
        <em>Bet365 · cuota ≥ 1,50</em>
      </div>
      <p className="final-verdict-method">
        Solo partidos oficiales de la competición y temporada indicadas. Si la temporada aún no tiene partidos, usa los primeros 5 y los últimos 5 de la anterior. H2H: misma competición primero y otras solo para completar dos.
      </p>
      {verdict && (
        <div className="final-verdict-samples">
          <span>{homeName}: {verdict.samples?.home?.count ?? 0} oficiales</span>
          <span>{awayName}: {verdict.samples?.away?.count ?? 0} oficiales</span>
          <span>H2H: {h2h.length}/2</span>
        </div>
      )}

      {!compact && <ExpectedRows verdict={verdict} homeName={homeName} awayName={awayName} />}

      <div className="final-verdict-picks">
        {!verdict ? (
          <div className="final-verdict-empty">El Veredicto final se está preparando con los partidos oficiales y las líneas reales de Bet365. El análisis actual permanece disponible.</div>
        ) : picks.length ? picks.map((pick) => (
          <article key={pick.id}>
            <span><small>{pick.market}</small><strong>{pick.name}</strong></span>
            <span className="final-verdict-numbers">
              <span><small>Probabilidad</small><b>{pct(pick.rawProbability ?? pick.probability)}</b></span>
              <span><small>Cuota</small><em>@{Number(pick.odd).toFixed(2)}</em></span>
            </span>
          </article>
        )) : (
          <div className="final-verdict-empty">No existe ahora una opción Bet365 que coincida con el cálculo, sea “Más de” cuando aplica y tenga cuota mínima de 1,50.</div>
        )}
      </div>

      {!compact && h2h.length > 0 && (
        <details className="final-verdict-h2h">
          <summary>Últimos H2H oficiales utilizados · {h2h.length}</summary>
          {h2h.map((match) => (
            <div key={match.fixtureId}>
              <span>{match.homeTeam || homeName} {match.homeScore ?? '—'}–{match.awayScore ?? '—'} {match.awayTeam || awayName}</span>
              <small>{match.date ? new Date(match.date).toLocaleDateString('es-ES') : ''} · {match.competition || `Competición ${match.competitionId}`}{match.sameCompetition ? ' · misma competición' : ' · complemento'}</small>
            </div>
          ))}
        </details>
      )}
    </section>
  );
}
