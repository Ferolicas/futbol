import CredentialsProvider from 'next-auth/providers/credentials';
import bcrypt from 'bcryptjs';
import { queryFromSanity } from './sanity';

export const authOptions = {
  providers: [
    CredentialsProvider({
      name: 'Credentials',
      credentials: {
        email: { label: 'Email', type: 'email' },
        password: { label: 'Password', type: 'password' },
      },
      async authorize(credentials) {
        if (!credentials?.email || !credentials?.password) return null;

        const user = await queryFromSanity(
          `*[_type == "cfaUser" && email == $email][0]{
            _id, name, email, password, role, plan, subscriptionStatus, stripeCustomerId
          }`,
          { email: credentials.email.toLowerCase().trim() }
        );

        if (!user || !user.password) return null;

        const isValid = await bcrypt.compare(credentials.password, user.password);
        if (!isValid) return null;

        // Check subscription is active
        if (user.subscriptionStatus !== 'active' && user.subscriptionStatus !== 'trialing') {
          // Allow login but mark as inactive
        }

        return {
          id: user._id,
          name: user.name,
          email: user.email,
          role: user.role || 'user',
          plan: user.plan || null,
          subscriptionStatus: user.subscriptionStatus || 'inactive',
          stripeCustomerId: user.stripeCustomerId || null,
        };
      },
    }),
  ],
  session: { strategy: 'jwt', maxAge: 30 * 24 * 60 * 60 },
  pages: {
    signIn: '/login',
    error: '/login',
  },
  callbacks: {
    async jwt({ token, user, trigger, session }) {
      if (user) {
        token.id = user.id;
        token.role = user.role;
        token.plan = user.plan;
        token.subscriptionStatus = user.subscriptionStatus;
        token.stripeCustomerId = user.stripeCustomerId;
      }
      // Allow session updates (e.g., after payment)
      if (trigger === 'update' && session) {
        if (session.plan) token.plan = session.plan;
        if (session.subscriptionStatus) token.subscriptionStatus = session.subscriptionStatus;
      }
      return token;
    },
    async session({ session, token }) {
      session.user.id = token.id;
      session.user.role = token.role;
      session.user.plan = token.plan;
      session.user.subscriptionStatus = token.subscriptionStatus;
      session.user.stripeCustomerId = token.stripeCustomerId;
      return session;
    },
  },
  secret: process.env.NEXTAUTH_SECRET,
};
