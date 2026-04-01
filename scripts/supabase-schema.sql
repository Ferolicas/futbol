-- ============================================================
-- CFAnalisis v2 — Supabase Schema
-- Run this ONCE in the Supabase SQL Editor
-- https://fdgxpznafsmhnuxjmcgd.supabase.co
-- ============================================================

-- ============================================================
-- USER PROFILES (extends Supabase Auth users)
-- ============================================================
CREATE TABLE IF NOT EXISTS user_profiles (
  id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  name TEXT,
  role TEXT DEFAULT 'user' CHECK (role IN ('user', 'admin', 'owner')),
  plan TEXT DEFAULT 'free' CHECK (plan IN ('free', 'plataforma', 'asesoria')),
  stripe_customer_id TEXT,
  timezone TEXT DEFAULT 'UTC',
  custom_league_ids INTEGER[],
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE user_profiles ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users can view own profile" ON user_profiles FOR SELECT USING (auth.uid() = id);
CREATE POLICY "Users can update own profile" ON user_profiles FOR UPDATE USING (auth.uid() = id);
CREATE POLICY "Admin full access to profiles" ON user_profiles FOR ALL USING (
  EXISTS (SELECT 1 FROM user_profiles WHERE id = auth.uid() AND role IN ('admin', 'owner'))
);

-- Auto-update updated_at
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER user_profiles_updated_at BEFORE UPDATE ON user_profiles
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- Auto-create profile on signup
CREATE OR REPLACE FUNCTION handle_new_user()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO user_profiles (id, email, name)
  VALUES (NEW.id, NEW.email, NEW.raw_user_meta_data->>'name')
  ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
CREATE TRIGGER on_auth_user_created AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION handle_new_user();

-- ============================================================
-- USER FAVORITES (per-user, per-fixture)
-- ============================================================
CREATE TABLE IF NOT EXISTS user_favorites (
  id SERIAL PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  fixture_id INTEGER NOT NULL,
  sport TEXT DEFAULT 'football',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, fixture_id)
);
ALTER TABLE user_favorites ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users manage own favorites" ON user_favorites FOR ALL USING (auth.uid() = user_id);
CREATE INDEX IF NOT EXISTS idx_favorites_user ON user_favorites(user_id);

-- ============================================================
-- USER HIDDEN (per-user, per-fixture — persists across reloads)
-- ============================================================
CREATE TABLE IF NOT EXISTS user_hidden (
  id SERIAL PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  fixture_id INTEGER NOT NULL,
  date DATE NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, fixture_id)
);
ALTER TABLE user_hidden ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users manage own hidden" ON user_hidden FOR ALL USING (auth.uid() = user_id);
CREATE INDEX IF NOT EXISTS idx_hidden_user_date ON user_hidden(user_id, date);

-- ============================================================
-- PUSH SUBSCRIPTIONS
-- ============================================================
CREATE TABLE IF NOT EXISTS push_subscriptions (
  id SERIAL PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  subscription JSONB NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id)
);
ALTER TABLE push_subscriptions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users manage own push" ON push_subscriptions FOR ALL USING (auth.uid() = user_id);

-- ============================================================
-- MATCH RESULTS (finalized matches with full stats)
-- ============================================================
CREATE TABLE IF NOT EXISTS match_results (
  fixture_id INTEGER PRIMARY KEY,
  date DATE NOT NULL,
  sport TEXT DEFAULT 'football',
  league_id INTEGER NOT NULL,
  league_name TEXT,
  home_team JSONB NOT NULL,
  away_team JSONB NOT NULL,
  goals JSONB,
  score JSONB,
  status JSONB,
  corners JSONB,
  yellow_cards JSONB,
  red_cards JSONB,
  goal_scorers JSONB,
  card_events JSONB,
  full_data JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_results_date ON match_results(date);
CREATE INDEX IF NOT EXISTS idx_results_league ON match_results(league_id);

-- ============================================================
-- MATCH ANALYSIS
-- ============================================================
CREATE TABLE IF NOT EXISTS match_analysis (
  id SERIAL PRIMARY KEY,
  fixture_id INTEGER NOT NULL,
  date DATE NOT NULL,
  analysis JSONB NOT NULL,
  odds JSONB,
  combinada JSONB,
  probabilities JSONB,
  data_quality TEXT DEFAULT 'good',
  cache_version INTEGER DEFAULT 7,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(fixture_id, date)
);
CREATE INDEX IF NOT EXISTS idx_analysis_date ON match_analysis(date);
CREATE INDEX IF NOT EXISTS idx_analysis_fixture ON match_analysis(fixture_id);

-- ============================================================
-- FIXTURES CACHE (replaces Sanity footballFixturesCache)
-- ============================================================
CREATE TABLE IF NOT EXISTS fixtures_cache (
  date DATE PRIMARY KEY,
  sport TEXT DEFAULT 'football',
  fixtures JSONB NOT NULL,
  fetched_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- APP CONFIG (replaces Sanity appConfig)
-- ============================================================
CREATE TABLE IF NOT EXISTS app_config (
  key TEXT PRIMARY KEY,
  value JSONB NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- MATCH SCHEDULE (replaces Sanity matchSchedule)
-- ============================================================
CREATE TABLE IF NOT EXISTS match_schedule (
  date DATE PRIMARY KEY,
  kickoff_times JSONB NOT NULL,
  first_kickoff BIGINT,
  last_expected_end BIGINT,
  fixture_count INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
