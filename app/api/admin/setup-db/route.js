/**
 * GET /api/admin/setup-db?secret=...&token=...
 * Creates missing Supabase tables via Management API.
 * token = Supabase personal access token (from supabase.com/dashboard/account/tokens)
 */
export const dynamic = 'force-dynamic';

const MIGRATION_SQL = `
CREATE TABLE IF NOT EXISTS public.tickets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id text UNIQUE NOT NULL,
  user_id uuid REFERENCES auth.users(id) ON DELETE CASCADE,
  user_name text,
  user_email text,
  message text NOT NULL,
  status text NOT NULL DEFAULT 'open',
  reply text,
  created_at timestamptz NOT NULL DEFAULT now(),
  replied_at timestamptz
);
ALTER TABLE public.tickets ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Users can view own tickets" ON public.tickets;
CREATE POLICY "Users can view own tickets" ON public.tickets FOR SELECT USING (auth.uid() = user_id);
DROP POLICY IF EXISTS "Users can insert own tickets" ON public.tickets;
CREATE POLICY "Users can insert own tickets" ON public.tickets FOR INSERT WITH CHECK (auth.uid() = user_id);
DROP POLICY IF EXISTS "Service role full access tickets" ON public.tickets;
CREATE POLICY "Service role full access tickets" ON public.tickets FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE TABLE IF NOT EXISTS public.chat_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid REFERENCES auth.users(id) ON DELETE CASCADE,
  user_name text,
  user_email text,
  message text NOT NULL,
  sender text NOT NULL DEFAULT 'user',
  read boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.chat_messages ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Users can view own messages" ON public.chat_messages;
CREATE POLICY "Users can view own messages" ON public.chat_messages FOR SELECT USING (auth.uid() = user_id);
DROP POLICY IF EXISTS "Users can insert own messages" ON public.chat_messages;
CREATE POLICY "Users can insert own messages" ON public.chat_messages FOR INSERT WITH CHECK (auth.uid() = user_id);
DROP POLICY IF EXISTS "Service role full access chat" ON public.chat_messages;
CREATE POLICY "Service role full access chat" ON public.chat_messages FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE TABLE IF NOT EXISTS public.combinadas (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid REFERENCES auth.users(id) ON DELETE CASCADE,
  name text,
  selections jsonb,
  combined_odd float,
  combined_probability float,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.combinadas ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Users can manage own combinadas" ON public.combinadas;
CREATE POLICY "Users can manage own combinadas" ON public.combinadas FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
DROP POLICY IF EXISTS "Service role full access combinadas" ON public.combinadas;
CREATE POLICY "Service role full access combinadas" ON public.combinadas FOR ALL TO service_role USING (true) WITH CHECK (true);

ALTER TABLE public.user_profiles
  ADD COLUMN IF NOT EXISTS subscription_status text DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS country text;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'push_subscriptions_user_id_key') THEN
    ALTER TABLE public.push_subscriptions ADD CONSTRAINT push_subscriptions_user_id_key UNIQUE (user_id);
  END IF;
END $$;

-- Calibración v1.2: tarjetas, primer gol, goleadores
ALTER TABLE public.match_predictions
  ADD COLUMN IF NOT EXISTS p_cards_over_25 INTEGER,
  ADD COLUMN IF NOT EXISTS p_cards_over_35 INTEGER,
  ADD COLUMN IF NOT EXISTS p_cards_over_45 INTEGER,
  ADD COLUMN IF NOT EXISTS p_first_goal_30 INTEGER,
  ADD COLUMN IF NOT EXISTS p_first_goal_45 INTEGER,
  ADD COLUMN IF NOT EXISTS predicted_scorers JSONB,
  ADD COLUMN IF NOT EXISTS actual_total_cards INTEGER,
  ADD COLUMN IF NOT EXISTS actual_first_goal_minute INTEGER,
  ADD COLUMN IF NOT EXISTS actual_goal_minutes INTEGER[],
  ADD COLUMN IF NOT EXISTS actual_goal_scorers JSONB;
`;

export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const secret = searchParams.get('secret');
  const token = searchParams.get('token');

  if (secret !== process.env.CRON_SECRET) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  if (!token) {
    return Response.json({
      error: 'Missing token parameter',
      instructions: 'Add ?token=YOUR_SUPABASE_PAT to the URL. Get your PAT from: https://supabase.com/dashboard/account/tokens',
      sql: MIGRATION_SQL,
    });
  }

  try {
    const res = await fetch('https://api.supabase.com/v1/projects/fdgxpznafsmhnuxjmcgd/database/query', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ query: MIGRATION_SQL }),
    });

    const data = await res.json();

    if (!res.ok) {
      return Response.json({ error: 'Migration failed', details: data, status: res.status });
    }

    return Response.json({ success: true, message: 'Tables created successfully', result: data });
  } catch (e) {
    return Response.json({ error: e.message }, { status: 500 });
  }
}
