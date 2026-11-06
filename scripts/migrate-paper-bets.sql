-- Apuestas sin dinero: registro personal de lo que el propietario abre de
-- verdad en la casa, con importe ficticio. Es independiente del motor y de las
-- recomendaciones: solo guarda lo elegido, su cuota y cómo terminó.

CREATE TABLE IF NOT EXISTS paper_bets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  stake numeric(14,2) NOT NULL CHECK (stake > 0),
  total_odd numeric(14,3) NOT NULL CHECK (total_odd >= 1),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'won', 'lost', 'void')),
  payout numeric(14,2),
  note text,
  placed_at timestamptz NOT NULL DEFAULT now(),
  settled_at timestamptz
);

CREATE TABLE IF NOT EXISTS paper_bet_legs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bet_id uuid NOT NULL REFERENCES paper_bets(id) ON DELETE CASCADE,
  position smallint NOT NULL DEFAULT 0,
  sport text NOT NULL,
  fixture_id text,
  kickoff timestamptz,
  league_name text,
  home_team text,
  away_team text,
  -- Equipo sobre el que trata la selección ('home', 'away') o NULL si es del
  -- partido entero (total, ambos marcan…).
  team_side text CHECK (team_side IN ('home', 'away')),
  market_id text,
  market_name text NOT NULL,
  market_family text NOT NULL DEFAULT 'otros',
  market_period text,
  line numeric,
  side text,
  odd numeric(10,3) NOT NULL CHECK (odd >= 1),
  probability numeric(6,2),
  reliability numeric(6,2),
  bookmaker text,
  source text NOT NULL DEFAULT 'recommended' CHECK (source IN ('recommended', 'manual')),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'won', 'lost', 'void')),
  settled_by text CHECK (settled_by IN ('auto', 'manual')),
  settled_at timestamptz
);

CREATE INDEX IF NOT EXISTS paper_bets_user_placed_idx ON paper_bets (user_id, placed_at DESC);
CREATE INDEX IF NOT EXISTS paper_bet_legs_bet_idx ON paper_bet_legs (bet_id);
CREATE INDEX IF NOT EXISTS paper_bet_legs_pending_idx ON paper_bet_legs (sport, fixture_id) WHERE status = 'pending';

-- Cuota conjunta de «Crear apuesta»: varias selecciones del mismo partido que
-- la casa cotiza con un solo precio. Todas las del grupo guardan la misma.
ALTER TABLE paper_bet_legs ADD COLUMN IF NOT EXISTS group_odd numeric(10,3) CHECK (group_odd >= 1);
