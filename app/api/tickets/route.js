import { getServerSession } from 'next-auth/next';
import { authOptions } from '../../../lib/auth';
import { queryFromSanity, saveToSanity } from '../../../lib/sanity';
import { sendTicketNotification } from '../../../lib/resend-email';

export const dynamic = 'force-dynamic';

// GET: List tickets
export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const userId = session.user.id;
  const isAdmin = session.user.role === 'admin';

  try {
    let tickets;
    if (isAdmin) {
      tickets = await queryFromSanity(
        `*[_type == "cfaTicket"] | order(createdAt desc) {
          _id, ticketId, userId, userName, userEmail, message, status, reply, createdAt, repliedAt
        }`
      );
    } else {
      tickets = await queryFromSanity(
        `*[_type == "cfaTicket" && userId == $userId] | order(createdAt desc) {
          _id, ticketId, message, status, reply, createdAt, repliedAt
        }`,
        { userId }
      );
    }

    return Response.json({ tickets: tickets || [] });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
}

// POST: Create a ticket or reply to one
export async function POST(request) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const userId = session.user.id;
  const isAdmin = session.user.role === 'admin';
  const { message, ticketDocId, reply } = await request.json();

  try {
    if (isAdmin && ticketDocId && reply) {
      const existing = await queryFromSanity(
        `*[_type == "cfaTicket" && _id == $id][0]`,
        { id: `cfaTicket-${ticketDocId}` }
      );
      if (existing) {
        const docId = existing._id.replace('cfaTicket-', '');
        await saveToSanity('cfaTicket', docId, {
          ...existing,
          _id: undefined,
          _type: undefined,
          reply,
          status: 'replied',
          repliedAt: new Date().toISOString(),
        });
      }
      return Response.json({ success: true });
    }

    if (!message?.trim()) {
      return Response.json({ error: 'Message required' }, { status: 400 });
    }

    const existingTickets = await queryFromSanity(`count(*[_type == "cfaTicket"])`);
    const ticketNum = 1000 + (existingTickets || 0);
    const ticketId = `CFA_${ticketNum}`;

    const docId = `ticket-${Date.now()}`;
    await saveToSanity('cfaTicket', docId, {
      ticketId,
      userId,
      userName: session.user.name,
      userEmail: session.user.email,
      message: message.trim(),
      status: 'open',
      createdAt: new Date().toISOString(),
    });

    sendTicketNotification({
      ticketId,
      message: message.trim(),
      userEmail: session.user.email,
      userName: session.user.name,
    }).catch(() => {});

    return Response.json({ success: true, ticketId });
  } catch (error) {
    console.error('Ticket error:', error);
    return Response.json({ error: error.message }, { status: 500 });
  }
}
