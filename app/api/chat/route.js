import { auth } from '@clerk/nextjs/server';
import { getSanityUserByClerkId } from '../../../lib/clerk-sync';
import { queryFromSanity, saveToSanity } from '../../../lib/sanity';
import { sendChatNotification } from '../../../lib/resend-email';
import { triggerEvent } from '../../../lib/pusher';

export const dynamic = 'force-dynamic';

// GET: Fetch chat messages for current user (or all for admin)
export async function GET(request) {
  const { userId: clerkId } = await auth();
  if (!clerkId) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const sanityUser = await getSanityUserByClerkId(clerkId);
  if (!sanityUser?._id) {
    return Response.json({ error: 'User not found' }, { status: 404 });
  }

  const { searchParams } = new URL(request.url);
  const targetUserId = searchParams.get('userId');
  const isAdmin = sanityUser.role === 'admin';

  try {
    if (isAdmin && !targetUserId) {
      const messages = await queryFromSanity(
        `*[_type == "cfaChat"] | order(_createdAt desc) {
          _id, userId, userName, userEmail, message, sender, read, createdAt
        }[0..200]`
      );

      const conversations = {};
      (messages || []).forEach(m => {
        if (!conversations[m.userId]) {
          conversations[m.userId] = {
            userId: m.userId,
            userName: m.userName,
            userEmail: m.userEmail,
            messages: [],
            unreadCount: 0,
            lastMessage: null,
          };
        }
        conversations[m.userId].messages.push(m);
        if (!m.read && m.sender === 'user') conversations[m.userId].unreadCount++;
        if (!conversations[m.userId].lastMessage) conversations[m.userId].lastMessage = m;
      });

      return Response.json({ conversations: Object.values(conversations) });
    }

    const userId = isAdmin && targetUserId ? targetUserId : sanityUser._id;
    const messages = await queryFromSanity(
      `*[_type == "cfaChat" && userId == $userId] | order(createdAt asc) {
        _id, message, sender, read, createdAt
      }`,
      { userId }
    );

    return Response.json({ messages: messages || [] });
  } catch (error) {
    console.error('Chat GET error:', error);
    return Response.json({ error: error.message }, { status: 500 });
  }
}

// POST: Send a chat message
export async function POST(request) {
  const { userId: clerkId } = await auth();
  if (!clerkId) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const sanityUser = await getSanityUserByClerkId(clerkId);
  if (!sanityUser?._id) {
    return Response.json({ error: 'User not found' }, { status: 404 });
  }

  const { message, targetUserId } = await request.json();
  if (!message?.trim()) {
    return Response.json({ error: 'Message required' }, { status: 400 });
  }

  const isAdmin = sanityUser.role === 'admin';
  const sender = isAdmin ? 'agent' : 'user';
  const userId = isAdmin && targetUserId ? targetUserId : sanityUser._id;

  const msgId = `chat-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

  try {
    await saveToSanity('cfaChat', msgId, {
      userId,
      userName: sanityUser.name,
      userEmail: sanityUser.email,
      message: message.trim(),
      sender,
      read: false,
      createdAt: new Date().toISOString(),
    });

    // Push real-time via Pusher
    await triggerEvent(`chat-${userId}`, 'new-message', {
      _id: `cfaChat-${msgId}`,
      message: message.trim(),
      sender,
      createdAt: new Date().toISOString(),
    });

    // Also notify admin channel
    if (sender === 'user') {
      await triggerEvent('chat-admin', 'new-message', {
        userId,
        userName: sanityUser.name,
        message: message.trim(),
        createdAt: new Date().toISOString(),
      });

      sendChatNotification({
        userName: sanityUser.name,
        userEmail: sanityUser.email,
        message: message.trim(),
      }).catch(() => {});
    }

    return Response.json({ success: true, id: msgId });
  } catch (error) {
    console.error('Chat POST error:', error);
    return Response.json({ error: error.message }, { status: 500 });
  }
}

// PATCH: Mark messages as read
export async function PATCH(request) {
  const { userId: clerkId } = await auth();
  if (!clerkId) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { messageIds } = await request.json();
  if (!messageIds?.length) return Response.json({ success: true });

  try {
    await Promise.all(
      messageIds.map(async (id) => {
        const doc = await queryFromSanity(
          `*[_type == "cfaChat" && _id == $id][0]`,
          { id: `cfaChat-${id}` }
        );
        if (doc) {
          const docId = doc._id.replace('cfaChat-', '');
          await saveToSanity('cfaChat', docId, { ...doc, read: true, _id: undefined, _type: undefined });
        }
      })
    );

    return Response.json({ success: true });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
}
