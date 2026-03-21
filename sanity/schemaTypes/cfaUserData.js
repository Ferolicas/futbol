export default {
  name: 'cfaUserData',
  title: 'Datos de Usuario',
  type: 'document',
  fields: [
    { name: 'userId', title: 'User ID', type: 'string' },
    { name: 'dataType', title: 'Tipo', type: 'string', options: { list: ['hidden', 'analyzed', 'removedAnalyzed', 'pushSubscription'] } },
    { name: 'date', title: 'Fecha', type: 'string' },
    { name: 'fixtureIds', title: 'Fixture IDs', type: 'array', of: [{ type: 'number' }] },
    { name: 'subscription', title: 'Push Subscription JSON', type: 'text' },
    { name: 'updatedAt', title: 'Actualizado', type: 'datetime' },
  ],
  preview: {
    select: { title: 'userId', subtitle: 'dataType' },
  },
};
