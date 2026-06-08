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
  gf_with     real,   gf_without  real,   -- goles a favor del equipo (avg) con / sin
  ga_with     real,   ga_without  real,   -- goles en contra (avg) con / sin
  delta_gf    real,                        -- gf_with - gf_without (modulador ofensivo)
  delta_ga    real,                        -- ga_with - ga_without (modulador defensivo, uso posterior)
  n_with      int,    n_without   int,     -- tamaños de muestra de cada lado
  determinant boolean,                     -- abs(delta_gf)>=0.5 AND n_with>=20 AND n_without>=20
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (player_id, team_id)
);
CREATE INDEX IF NOT EXISTS ix_player_impact_team        ON model.player_impact(team_id);
CREATE INDEX IF NOT EXISTS ix_player_impact_determinant ON model.player_impact(player_id) WHERE determinant;
