-- ============================================================================
-- Tabla: audit_logs
-- Bitacora de acciones administrativas del panel /ferney y, en general, de
-- cualquier operacion server-side que modifique datos relevantes.
--
-- Vive en el VPS Postgres (la migracion supabaseAdmin.from → pgAdmin del
-- commit b89c9b1 ya hace que toda escritura desde Vercel termine aqui).
--
-- Ejecutar UNA VEZ:
--   psql "$DATABASE_URL" -f scripts/migrate-audit-logs.sql
-- ============================================================================

create table if not exists public.audit_logs (
  id         serial primary key,
  user_id    uuid    not null,
  user_email text,
  action     text    not null,
  entity     text,
  entity_id  text,
  payload    jsonb,
  ip         text,
  user_agent text,
  created_at timestamptz default now()
);

create index if not exists idx_audit_logs_created on public.audit_logs (created_at desc);
create index if not exists idx_audit_logs_user    on public.audit_logs (user_id);
create index if not exists idx_audit_logs_action  on public.audit_logs (action);

comment on table  public.audit_logs            is 'Bitacora de acciones admin (/ferney) y operaciones sensibles.';
comment on column public.audit_logs.action     is 'Verbo corto en kebab-case, ej. publish-combinada, edit-ticket, retry-job.';
comment on column public.audit_logs.entity     is 'Tipo de objeto afectado, ej. combinada_dia, ticket, queue.';
comment on column public.audit_logs.entity_id  is 'ID del objeto (cadena para soportar uuid, serial, queue name).';
comment on column public.audit_logs.payload    is 'Detalles libres (diff, query params, motivo). Evitar guardar PII.';
