export default {
  name: 'footballMatchAnalysis',
  title: 'Analisis de Partidos',
  type: 'document',
  fields: [
    { name: 'fixtureId', title: 'Fixture ID', type: 'number' },
    { name: 'homeTeam', title: 'Local', type: 'string' },
    { name: 'awayTeam', title: 'Visitante', type: 'string' },
    { name: 'league', title: 'Liga', type: 'string' },
    { name: 'leagueId', title: 'Liga ID', type: 'number' },
    { name: 'kickoff', title: 'Hora', type: 'string' },
    { name: 'status', title: 'Estado', type: 'string' },
    { name: 'fetchedAt', title: 'Fecha Carga', type: 'datetime' },
  ],
  preview: {
    select: { home: 'homeTeam', away: 'awayTeam', league: 'league' },
    prepare({ home, away, league }) {
      return { title: `${home || '?'} vs ${away || '?'}`, subtitle: league };
    },
  },
};
