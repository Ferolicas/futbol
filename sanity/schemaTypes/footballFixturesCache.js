export default {
  name: 'footballFixturesCache',
  title: 'Cache de Partidos',
  type: 'document',
  fields: [
    { name: 'date', title: 'Fecha', type: 'string' },
    { name: 'fetchedAt', title: 'Cargado', type: 'datetime' },
    { name: 'fixtureCount', title: 'Cantidad', type: 'number' },
  ],
  preview: {
    select: { title: 'date', subtitle: 'fixtureCount' },
    prepare({ title, subtitle }) {
      return { title: `Partidos ${title}`, subtitle: `${subtitle || 0} partidos` };
    },
  },
};
