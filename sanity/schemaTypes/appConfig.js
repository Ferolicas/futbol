export default {
  name: 'appConfig',
  title: 'Configuracion App',
  type: 'document',
  fields: [
    { name: 'date', title: 'Fecha', type: 'string' },
    { name: 'started', title: 'Iniciado', type: 'boolean' },
    { name: 'completed', title: 'Completado', type: 'boolean' },
    { name: 'fixtureCount', title: 'Partidos', type: 'number' },
    { name: 'count', title: 'Contador', type: 'number' },
    { name: 'startedAt', title: 'Inicio', type: 'datetime' },
    { name: 'completedAt', title: 'Fin', type: 'datetime' },
  ],
  preview: {
    select: { title: '_id', subtitle: 'date' },
  },
};
