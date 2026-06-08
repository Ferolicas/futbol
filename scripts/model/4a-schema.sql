-- ════════════════════════════════════════════════════════════════════════
-- FASE 4A — model.player_impact: impacto MEDIDO del jugador (decisión #6).
--
--   psql "$DATABASE_URL" -f scripts/model/4a-schema.sql
--
-- Mide, por par (jugador, equipo), cuánto rinde el EQUIPO con el jugador en
-- cancha vs sin él, dentro de su ETAPA en el club (entre su primera y última
-- aparición). No mide presencia ni goles propios: mide el delta del equipo.
--   gf_with/gf_without  → goles a favor del equipo con / sin el jugador
--   ga_with/ga_without  → goles en contra (para el modulador defensivo posterior)
--   delta_gf = gf_with - gf_without   (>0 ⇒ el equipo marca más con él)
--   determinant = abs(delta_gf) >= 0.5 AND n_with>=20 AND n_without>=20 (señal real;
--                 0.3/n5 marcaba ~49% = ruido de muestra chica)
--   cards/fouls (yellow+red y fouls_for de team_match_stats) y penaltis concedidos
--     (SUM penalty_committed de player_match_stats), misma mecánica con/sin. n SEPARADO
--     por cobertura: n_with/n_without (goles, todos los partidos), n_stats_* (cards/fouls,
--     partidos con stats de equipo) y n_pen_* (penaltis, partidos con dato de jugador).
-- Solo se materializan pares con n_with>=5 Y n_without>=5 (ambos lados medibles);
-- un titular que juega SIEMPRE no tiene "sin" → sin fila → el motor no modula.
--
-- Borde menor aceptado: jugador con dos etapas en el mismo club → la ventana
-- simple [primera, última] incluye el lapso intermedio como "sin". Es minoritario
-- y no se corrige en 4A.
--
-- ANTI-FUGA: esta tabla es ESTADO ACTUAL = solo SERVING (como los perfiles 2F).
-- El backtest NO la lee; recomputa el impacto point-in-time desde los hechos.
-- Idempotente: CREATE IF NOT EXISTS; el builder hace TRUNCATE (full) o DELETE+reinsert (incremental).
-- ════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS model.player_impact (
  player_id   bigint NOT NULL,
  team_id     bigint NOT NULL,
  gf_with      real,  gf_without    real,  -- goles a favor del equipo (avg) con / sin
  ga_with      real,  ga_without    real,  -- goles en contra (avg) con / sin
  delta_gf     real,                       -- gf_with - gf_without (modulador ofensivo)
  delta_ga     real,                       -- ga_with - ga_without (modulador defensivo)
  cards_with   real,  cards_without real,  -- tarjetas del equipo (yellow+red) con / sin
  delta_cards  real,                       -- cards_with - cards_without
  fouls_with   real,  fouls_without real,  -- faltas del equipo (fouls_for) con / sin
  delta_fouls  real,                       -- fouls_with - fouls_without
  n_stats_with int,   n_stats_without int, -- muestra de cards/fouls (partidos con stats de equipo)
  pen_with     real,  pen_without   real,  -- penaltis concedidos del equipo (SUM player) con / sin
  delta_pen    real,                       -- pen_with - pen_without
  n_pen_with   int,   n_pen_without int,   -- muestra de penaltis (partidos con dato de jugador)
  n_with       int,   n_without     int,   -- muestra de goles (todos los partidos de la ventana)
  determinant  boolean,                    -- abs(delta_gf)>=0.5 AND n_with>=20 AND n_without>=20
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (player_id, team_id)
);
-- Ampliación cards/fouls/penaltis: idempotente para tablas existentes con datos de goles
-- (ADD COLUMN IF NOT EXISTS, sin DROP — no recalcula goles salvo que se corra el build).
ALTER TABLE model.player_impact
  ADD COLUMN IF NOT EXISTS cards_with      real,
  ADD COLUMN IF NOT EXISTS cards_without   real,
  ADD COLUMN IF NOT EXISTS delta_cards     real,
  ADD COLUMN IF NOT EXISTS fouls_with      real,
  ADD COLUMN IF NOT EXISTS fouls_without   real,
  ADD COLUMN IF NOT EXISTS delta_fouls     real,
  ADD COLUMN IF NOT EXISTS n_stats_with    int,
  ADD COLUMN IF NOT EXISTS n_stats_without int,
  ADD COLUMN IF NOT EXISTS pen_with        real,
  ADD COLUMN IF NOT EXISTS pen_without     real,
  ADD COLUMN IF NOT EXISTS delta_pen       real,
  ADD COLUMN IF NOT EXISTS n_pen_with      int,
  ADD COLUMN IF NOT EXISTS n_pen_without   int;
CREATE INDEX IF NOT EXISTS ix_player_impact_team        ON model.player_impact(team_id);
CREATE INDEX IF NOT EXISTS ix_player_impact_determinant ON model.player_impact(player_id) WHERE determinant;
