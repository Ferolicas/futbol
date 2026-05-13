-- ============================================================================
-- Tabla: combinada_dia
-- Snapshot publicable de la "Apuesta del Día" calculada por el cron
-- /api/cron/publish-combinada. Es independiente del calculo en vivo que
-- hace el dashboard (useMemo apuestaDelDia) — el dashboard sigue tal cual.
--
-- Ejecutar UNA SOLA VEZ desde el SQL editor:
--   https://supabase.com/dashboard/project/fdgxpznafsmhnuxjmcgd/sql/new
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
comment on column public.combinada_dia.selections           is 'Array JSON con las selecciones del cron (>=90% prob, >=1.20 cuota).';
comment on column public.combinada_dia.combined_odd         is 'Producto de cuotas de todas las selecciones.';
comment on column public.combinada_dia.combined_probability is 'Promedio de probabilidades de todas las selecciones (proxy de confianza).';
comment on column public.combinada_dia.status               is 'draft = en proceso/sin revisar | published = lista para mostrar.';
