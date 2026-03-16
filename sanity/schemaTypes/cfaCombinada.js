export default {
  name: 'cfaCombinada',
  title: 'Combinadas',
  type: 'document',
  fields: [
    { name: 'userId', title: 'User ID', type: 'string' },
    { name: 'name', title: 'Nombre', type: 'string' },
    { name: 'selections', title: 'Selecciones', type: 'array', of: [{ type: 'object', fields: [
      { name: 'matchName', title: 'Partido', type: 'string' },
      { name: 'market', title: 'Mercado', type: 'string' },
      { name: 'odd', title: 'Cuota', type: 'number' },
      { name: 'probability', title: 'Probabilidad', type: 'number' },
    ]}]},
    { name: 'combinedOdd', title: 'Cuota Combinada', type: 'number' },
    { name: 'combinedProbability', title: 'Probabilidad Combinada', type: 'number' },
    { name: 'createdAt', title: 'Fecha', type: 'datetime' },
  ],
  preview: {
    select: { title: 'name', subtitle: 'combinedOdd' },
  },
};
