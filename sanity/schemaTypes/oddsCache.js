export default {
  name: 'oddsCache',
  title: 'Odds Cache',
  type: 'document',
  fields: [
    { name: 'fixtureId', title: 'Fixture ID', type: 'number' },
    { name: 'date', title: 'Date', type: 'string' },
    { name: 'odds', title: 'Odds Data', type: 'object', fields: [] },
    { name: 'source', title: 'Source', type: 'string' },
    { name: 'fetchedAt', title: 'Fetched At', type: 'datetime' },
  ],
};
