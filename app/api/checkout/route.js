import { createCheckoutSession } from '../../../lib/stripe';
import { queryFromSanity, saveToSanity } from '../../../lib/sanity';

export async function POST(request) {
  try {
    const { plan, userId, email, localCurrency, exchangeRate } = await request.json();

    if (!plan || !userId || !email) {
      return Response.json({ error: 'Missing required fields' }, { status: 400 });
    }

    if (!['plataforma', 'asesoria'].includes(plan)) {
      return Response.json({ error: 'Invalid plan' }, { status: 400 });
    }

    // Get user from Sanity
    const user = await queryFromSanity(
      `*[_type == "cfaUser" && email == $email][0]{ _id, name, email }`,
      { email: email.toLowerCase().trim() }
    );

    if (!user) {
      return Response.json({ error: 'User not found' }, { status: 404 });
    }

    const session = await createCheckoutSession({
      plan,
      userId: user._id,
      email: user.email,
      name: user.name,
      localCurrency,
      exchangeRate,
    });

    // Update user with pending plan
    const docId = user._id.replace('cfaUser-', '');
    await saveToSanity('cfaUser', docId, {
      name: user.name,
      email: user.email,
      plan,
      subscriptionStatus: 'pending',
      updatedAt: new Date().toISOString(),
    });

    return Response.json({ url: session.url, sessionId: session.id });
  } catch (error) {
    console.error('Checkout error:', error);
    return Response.json({ error: error.message || 'Checkout failed' }, { status: 500 });
  }
}
