export default {
  name: 'cfaTicket',
  title: 'Tickets',
  type: 'document',
  fields: [
    { name: 'ticketId', title: 'Ticket ID', type: 'string' },
    { name: 'userId', title: 'User ID', type: 'string' },
    { name: 'userName', title: 'Nombre', type: 'string' },
    { name: 'userEmail', title: 'Email', type: 'string' },
    { name: 'message', title: 'Mensaje', type: 'text' },
    { name: 'status', title: 'Estado', type: 'string', options: { list: ['open', 'replied', 'closed'] } },
    { name: 'reply', title: 'Respuesta', type: 'text' },
    { name: 'repliedAt', title: 'Fecha Respuesta', type: 'datetime' },
    { name: 'createdAt', title: 'Fecha', type: 'datetime' },
  ],
  preview: {
    select: { title: 'ticketId', subtitle: 'message' },
  },
};
