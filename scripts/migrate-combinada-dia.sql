-- ============================================================================
-- Tabla: combinada_dia
-- Snapshot publicable de la "Apuesta del Día" calculada por el cron
-- /api/cron/publish-combinada. Es independiente del calculo en vivo que
-- hace el dashboard (useMemo apuestaDelDia) — el dashboard sigue tal cual.
--
-- ⚠️ USO EXCLUSIVO DE n8n.
--   Esta tabla la lee SOLO la automatizacion de n8n (publicacion de la
--   apuesta del dia en Telegram). El frontend NO la consulta nunca:
--   el widget "Apuesta del Dia" se calcula client-side desde analyzedData.
--   No confundir con la tabla `combinadas` (combinadas guardadas por
--   usuario, escritas desde /api/user type=save-combinada).
--
-- Ejecutar UNA SOLA VEZ contra el VPS Postgres:
--   psql "$DATABASE_URL" -f scripts/migrate-combinada-dia.sql
-- ============================================================================

create table if not exists public.combinada_dia (
  id                   uuid        primary key default gen_random_uuid(),
  fecha                date        not null unique,
  selections           jsonb,
  combined_odd         numeric,
  combined_probability numeric,
  status               text        default 'draft',
  created_at           timestamptz default now()
);

-- Indices utiles para queries por fecha/status
create index if not exists combinada_dia_fecha_idx
  on public.combinada_dia (fecha desc);

create index if not exists combinada_dia_status_idx
  on public.combinada_dia (status);

-- Comentarios para que el schema sea autoexplicativo
comment on table  public.combinada_dia                      is 'Snapshot publicable de la combinada del dia (cron-generated).';
comment on column public.combinada_dia.fecha                is 'Dia al que pertenece la combinada (UNIQUE — solo una por dia).';
comment on column public.combinada_dia.selections           is 'Array JSON de todos los PARTIDOS publicables; cada uno con `options` (1 a 3 opciones: >=85% prob, >=90% fiabilidad, cuota >=1.20 sin techo).';
comment on column public.combinada_dia.combined_odd         is 'OBSOLETA: siempre null desde que la apuesta del dia dejo de ser una combinada.';
comment on column public.combinada_dia.combined_probability is 'OBSOLETA: siempre null desde que la apuesta del dia dejo de ser una combinada.';
comment on column public.combinada_dia.status               is 'draft = en proceso/sin revisar | published = lista para mostrar.';
