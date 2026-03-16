export default {
  name: 'cfaChat',
  title: 'Chat Mensajes',
  type: 'document',
  fields: [
    { name: 'userId', title: 'User ID', type: 'string' },
    { name: 'userName', title: 'Nombre Usuario', type: 'string' },
    { name: 'userEmail', title: 'Email Usuario', type: 'string' },
    { name: 'message', title: 'Mensaje', type: 'text' },
    { name: 'sender', title: 'Remitente', type: 'string', options: { list: ['user', 'agent'] } },
    { name: 'read', title: 'Leido', type: 'boolean' },
    { name: 'createdAt', title: 'Fecha', type: 'datetime' },
  ],
  preview: {
    select: { title: 'userName', subtitle: 'message' },
  },
};
