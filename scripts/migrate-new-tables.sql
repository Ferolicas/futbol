-- Migration: create tables needed for Sanity → Supabase migration
-- Run this once in the Supabase SQL Editor

-- ============================================================
-- tickets table
-- ============================================================
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
CREATE POLICY "Users can view own tickets" ON public.tickets
  FOR SELECT USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can insert own tickets" ON public.tickets;
CREATE POLICY "Users can insert own tickets" ON public.tickets
  FOR INSERT WITH CHECK (auth.uid() = user_id);

-- ============================================================
-- chat_messages table
-- ============================================================
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
CREATE POLICY "Users can view own messages" ON public.chat_messages
  FOR SELECT USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can insert own messages" ON public.chat_messages;
CREATE POLICY "Users can insert own messages" ON public.chat_messages
  FOR INSERT WITH CHECK (auth.uid() = user_id);

-- ============================================================
-- combinadas table
-- ============================================================
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
CREATE POLICY "Users can manage own combinadas" ON public.combinadas
  FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

-- ============================================================
-- user_profiles: add stripe and plan columns if missing
-- ============================================================
ALTER TABLE public.user_profiles
  ADD COLUMN IF NOT EXISTS stripe_customer_id text,
  ADD COLUMN IF NOT EXISTS plan text,
  ADD COLUMN IF NOT EXISTS subscription_status text DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS country text,
  ADD COLUMN IF NOT EXISTS updated_at timestamptz DEFAULT now();

-- ============================================================
-- push_subscriptions: ensure upsert key on user_id
-- ============================================================
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'push_subscriptions_user_id_key'
  ) THEN
    ALTER TABLE public.push_subscriptions ADD CONSTRAINT push_subscriptions_user_id_key UNIQUE (user_id);
  END IF;
END $$;

-- Service role bypass for admin operations (all tables)
CREATE POLICY IF NOT EXISTS "Service role full access tickets" ON public.tickets
  FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY IF NOT EXISTS "Service role full access chat" ON public.chat_messages
  FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY IF NOT EXISTS "Service role full access combinadas" ON public.combinadas
  FOR ALL TO service_role USING (true) WITH CHECK (true);
