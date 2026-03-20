import { stripe, createAsesoriaSubscription } from '../../../lib/stripe';
import { queryFromSanity, saveToSanity } from '../../../lib/sanity';
import { sendWelcomeEmail } from '../../../lib/resend-email';

async function findUserByCustomerId(customerId) {
  return queryFromSanity(
    `*[_type == "cfaUser" && stripeCustomerId == $customerId][0]{ _id, name, email, password, plan }`,
    { customerId }
  );
}

async function activateUser(user, plan, customerId) {
  const docId = user._id.replace('cfaUser-', '');
  await saveToSanity('cfaUser', docId, {
    name: user.name,
    email: user.email,
    password: user.password,
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
      // Embedded payment: subscription first invoice paid
      case 'invoice.payment_succeeded': {
        const invoice = event.data.object;
        const customerId = invoice.customer;
        const subscriptionId = invoice.subscription;

        // Only handle subscription invoices (not one-time)
        if (!subscriptionId) break;

        // Only handle the first invoice (activation)
        if (invoice.billing_reason !== 'subscription_create') break;

        const subscription = await stripe.subscriptions.retrieve(subscriptionId);
        const plan = subscription.metadata?.plan;

        const user = await findUserByCustomerId(customerId);
        if (user) {
          await activateUser(user, plan, customerId);
        }
        break;
      }

      // Embedded payment: one-time payment succeeded (asesoria $100)
      case 'payment_intent.succeeded': {
        const paymentIntent = event.data.object;
        const { userId, plan } = paymentIntent.metadata || {};
        const customerId = paymentIntent.customer;

        // Only handle asesoria one-time payments
        if (plan !== 'asesoria' || !customerId) break;

        const user = await findUserByCustomerId(customerId);
        if (!user) {
          // Fallback: find by userId from metadata
          const userById = await queryFromSanity(
            `*[_type == "cfaUser" && _id == $userId][0]{ _id, name, email, password, plan }`,
            { userId }
          );
          if (userById) {
            await activateUser(userById, 'asesoria', customerId);
          }
        } else {
          await activateUser(user, 'asesoria', customerId);
        }

        // Create the recurring subscription after $100 payment
        try {
          await createAsesoriaSubscription(customerId);
          console.log(`Asesoria subscription created for customer ${customerId}`);
        } catch (subErr) {
          console.error('Failed to create asesoria subscription:', subErr);
        }
        break;
      }

      case 'customer.subscription.updated': {
        const subscription = event.data.object;
        const customerId = subscription.customer;

        const user = await findUserByCustomerId(customerId);
        if (user) {
          const docId = user._id.replace('cfaUser-', '');
          const status = subscription.status === 'active' ? 'active'
            : subscription.status === 'trialing' ? 'trialing'
            : subscription.status === 'past_due' ? 'past_due'
            : 'inactive';

          await saveToSanity('cfaUser', docId, {
            name: user.name,
            email: user.email,
            password: user.password,
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

        const user = await findUserByCustomerId(customerId);
        if (user) {
          const docId = user._id.replace('cfaUser-', '');
          await saveToSanity('cfaUser', docId, {
            name: user.name,
            email: user.email,
            password: user.password,
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

        const user = await findUserByCustomerId(customerId);
        if (user) {
          const docId = user._id.replace('cfaUser-', '');
          await saveToSanity('cfaUser', docId, {
            name: user.name,
            email: user.email,
            password: user.password,
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
