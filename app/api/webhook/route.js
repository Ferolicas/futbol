import { stripe, createPostPaymentSubscription } from '../../../lib/stripe';
import { queryFromSanity, saveToSanity } from '../../../lib/sanity';
import { sendWelcomeEmail } from '../../../lib/resend-email';

async function findUser(customerId, userId) {
  // 1. By stripeCustomerId
  let user = await queryFromSanity(
    `*[_type == "cfaUser" && stripeCustomerId == $customerId][0]{ _id, name, email, password, plan, clerkId, role }`,
    { customerId }
  );
  if (user) return user;

  // 2. By userId from metadata
  if (userId) {
    user = await queryFromSanity(
      `*[_type == "cfaUser" && _id == $userId][0]{ _id, name, email, password, plan, clerkId, role }`,
      { userId }
    );
    if (user) return user;
  }

  // 3. Fallback: email from Stripe customer
  try {
    const customer = await stripe.customers.retrieve(customerId);
    if (customer?.email) {
      return queryFromSanity(
        `*[_type == "cfaUser" && email == $email][0]{ _id, name, email, password, plan, clerkId, role }`,
        { email: customer.email }
      );
    }
  } catch (e) {
    console.error('Fallback customer lookup failed:', e.message);
  }
  return null;
}

async function activateUser(user, plan, customerId) {
  const docId = user._id.replace('cfaUser-', '');
  await saveToSanity('cfaUser', docId, {
    name: user.name,
    email: user.email,
    password: user.password,
    role: user.role,
    plan: plan || 'plataforma',
    subscriptionStatus: 'active',
    stripeCustomerId: customerId,
    paidAt: new Date().toISOString(),
  });

  try {
    await sendWelcomeEmail({
      to: user.email,
      name: user.name,
      plan: plan || 'plataforma',
      password: '(la contrasena que elegiste al registrarte)',
    });
  } catch (emailErr) {
    console.error('Welcome email failed:', emailErr);
  }
}

export async function POST(request) {
  if (!stripe) {
    return Response.json({ error: 'Stripe not configured' }, { status: 500 });
  }

  const body = await request.text();
  const sig = request.headers.get('stripe-signature');
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

  let event;

  try {
    if (webhookSecret && sig) {
      event = stripe.webhooks.constructEvent(body, sig, webhookSecret);
    } else {
      event = JSON.parse(body);
    }
  } catch (err) {
    console.error('Webhook signature verification failed:', err.message);
    return Response.json({ error: 'Webhook signature failed' }, { status: 400 });
  }

  try {
    switch (event.type) {
      // Both plans: PaymentIntent succeeded → activate user + create subscription
      case 'payment_intent.succeeded': {
        const pi = event.data.object;
        const { userId, plan } = pi.metadata || {};
        const customerId = pi.customer;

        if (!plan || !customerId) break;

        const user = await findUser(customerId, userId);
        if (!user) {
          console.error(`Webhook: user not found for customer ${customerId}, userId ${userId}`);
          break;
        }

        await activateUser(user, plan, customerId);

        // Create recurring subscription (starts after 30-day trial)
        try {
          const sub = await createPostPaymentSubscription(customerId, plan);
          console.log(`Subscription created for ${plan}: ${sub.id}`);
        } catch (subErr) {
          console.error('Failed to create subscription:', subErr);
        }
        break;
      }

      case 'customer.subscription.updated': {
        const subscription = event.data.object;
        const customerId = subscription.customer;

        const user = await findUser(customerId);
        if (user) {
          const docId = user._id.replace('cfaUser-', '');
          const status = subscription.status === 'active' ? 'active'
            : subscription.status === 'trialing' ? 'active'
            : subscription.status === 'past_due' ? 'past_due'
            : 'inactive';

          await saveToSanity('cfaUser', docId, {
            name: user.name,
            email: user.email,
            password: user.password,
            clerkId: user.clerkId,
            role: user.role,
            plan: user.plan,
            subscriptionStatus: status,
            updatedAt: new Date().toISOString(),
          });
        }
        break;
      }

      case 'customer.subscription.deleted': {
        const subscription = event.data.object;
        const customerId = subscription.customer;

        const user = await findUser(customerId);
        if (user) {
          const docId = user._id.replace('cfaUser-', '');
          await saveToSanity('cfaUser', docId, {
            name: user.name,
            email: user.email,
            password: user.password,
            clerkId: user.clerkId,
            role: user.role,
            plan: user.plan,
            subscriptionStatus: 'cancelled',
            cancelledAt: new Date().toISOString(),
          });
        }
        break;
      }

      case 'invoice.payment_failed': {
        const invoice = event.data.object;
        const customerId = invoice.customer;

        const user = await findUser(customerId);
        if (user) {
          const docId = user._id.replace('cfaUser-', '');
          await saveToSanity('cfaUser', docId, {
            name: user.name,
            email: user.email,
            password: user.password,
            clerkId: user.clerkId,
            role: user.role,
            plan: user.plan,
            subscriptionStatus: 'past_due',
            updatedAt: new Date().toISOString(),
          });
        }
        break;
      }
    }
  } catch (error) {
    console.error('Webhook handler error:', error);
    return Response.json({ error: 'Webhook handler failed' }, { status: 500 });
  }

  return Response.json({ received: true });
}
