export default {
  name: 'cfaUser',
  title: 'Usuarios',
  type: 'document',
  fields: [
    { name: 'name', title: 'Nombre', type: 'string' },
    { name: 'email', title: 'Email', type: 'string' },
    { name: 'password', title: 'Password (hash)', type: 'string', hidden: true },
    { name: 'country', title: 'Pais', type: 'string' },
    { name: 'role', title: 'Rol', type: 'string', options: { list: ['user', 'admin'] } },
    { name: 'plan', title: 'Plan', type: 'string', options: { list: ['plataforma', 'asesoria'] } },
    { name: 'subscriptionStatus', title: 'Estado Suscripcion', type: 'string', options: { list: ['pending', 'active', 'trialing', 'past_due', 'cancelled', 'inactive'] } },
    { name: 'stripeCustomerId', title: 'Stripe Customer ID', type: 'string' },
    { name: 'stripeSessionId', title: 'Stripe Session ID', type: 'string' },
    { name: 'clerkId', title: 'Clerk ID', type: 'string' },
    { name: 'paidAt', title: 'Fecha de Pago', type: 'datetime' },
    { name: 'createdAt', title: 'Fecha de Registro', type: 'datetime' },
  ],
  preview: {
    select: { title: 'name', subtitle: 'email' },
  },
};
