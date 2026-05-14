-- ============================================================================
-- Tabla: referee_stats
-- Acumulador historico de tarjetas por arbitro. Alimentado por el worker
-- futbol-finalize cada vez que un partido termina (yellows + reds del partido
-- se suman al arbitro de fixture.referee).
--
-- El cron de analisis consulta esta tabla para ajustar la prediccion de
-- tarjetas: factor = clamp(arbitro.avg_cards / global_avg, 0.80, 1.20), con
-- minimo 10 partidos antes de aplicar (si no, factor = 1.00 → sin efecto).
--
-- Las columnas avg_* son GENERATED → siempre coherentes con los acumuladores.
--
-- Ejecutar UNA SOLA VEZ desde el SQL editor:
--   https://supabase.com/dashboard/project/fdgxpznafsmhnuxjmcgd/sql/new
-- ============================================================================

create table if not exists public.referee_stats (
  id              uuid        primary key default gen_random_uuid(),
  name            text        not null unique,
  matches         integer     not null default 0,
  total_yellows   integer     not null default 0,
  total_reds      integer     not null default 0,
  total_cards     integer     not null default 0,
  avg_yellows     numeric     generated always as (
                    case when matches > 0 then total_yellows::numeric / matches else 0 end
                  ) stored,
  avg_reds        numeric     generated always as (
                    case when matches > 0 then total_reds::numeric / matches else 0 end
                  ) stored,
  avg_cards       numeric     generated always as (
                    case when matches > 0 then total_cards::numeric / matches else 0 end
                  ) stored,
  last_match_date date,
  created_at      timestamptz default now(),
  updated_at      timestamptz default now()
);

-- Indice case-insensitive sobre el nombre: API-Football a veces varia
-- capitalizacion ("J. Doe" vs "J. DOE"). El upsert del finalize normaliza
-- usando lower(name) para evitar duplicados.
create index if not exists referee_stats_name_lower_idx
  on public.referee_stats (lower(name));

-- Indice para listar arbitros con muestra suficiente (matches >= 10)
create index if not exists referee_stats_matches_idx
  on public.referee_stats (matches desc);

comment on table  public.referee_stats               is 'Acumulador historico de tarjetas por arbitro. Alimenta el factor del modelo de cards.';
comment on column public.referee_stats.name          is 'Nombre del arbitro tal cual lo devuelve API-Football (fixture.referee).';
comment on column public.referee_stats.matches       is 'Numero de partidos dirigidos contabilizados.';
comment on column public.referee_stats.total_yellows is 'Suma acumulada de amarillas (home + away) en partidos dirigidos.';
comment on column public.referee_stats.total_reds    is 'Suma acumulada de rojas (home + away) en partidos dirigidos.';
comment on column public.referee_stats.total_cards   is 'Suma acumulada de tarjetas totales (yellows + reds) en partidos dirigidos.';
comment on column public.referee_stats.avg_yellows   is 'GENERATED — total_yellows / matches.';
comment on column public.referee_stats.avg_reds      is 'GENERATED — total_reds / matches.';
comment on column public.referee_stats.avg_cards     is 'GENERATED — total_cards / matches. Es el valor que consume el modelo.';

-- ============================================================================
-- Funcion: increment_referee_stats
-- Upsert atomico que suma tarjetas de UN partido al acumulador del arbitro.
-- Idempotencia: la garantiza el caller (finalize.js solo invoca esta funcion
-- cuando inserta una fila NUEVA en match_results, no en reintentos).
--
-- Uso desde JS:
--   supabaseAdmin.rpc('increment_referee_stats', {
--     p_name: 'M. Oliver', p_yellows: 4, p_reds: 0, p_match_date: '2026-05-14'
--   });
-- ============================================================================
create or replace function public.increment_referee_stats(
  p_name        text,
  p_yellows     int,
  p_reds        int,
  p_match_date  date
) returns void as $$
begin
  if p_name is null or length(trim(p_name)) = 0 then
    return;
  end if;

  insert into public.referee_stats (name, matches, total_yellows, total_reds, total_cards, last_match_date)
  values (trim(p_name), 1, coalesce(p_yellows, 0), coalesce(p_reds, 0),
          coalesce(p_yellows, 0) + coalesce(p_reds, 0), p_match_date)
  on conflict (name) do update
    set matches         = referee_stats.matches + 1,
        total_yellows   = referee_stats.total_yellows + excluded.total_yellows,
        total_reds      = referee_stats.total_reds + excluded.total_reds,
        total_cards     = referee_stats.total_cards + excluded.total_cards,
        last_match_date = greatest(referee_stats.last_match_date, excluded.last_match_date),
        updated_at      = now();
end;
$$ language plpgsql;

comment on function public.increment_referee_stats(text, int, int, date)
  is 'Suma 1 partido al acumulador del arbitro. Llamado desde el worker futbol-finalize.';
