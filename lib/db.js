/**
 * lib/db.js — Cliente PostgreSQL con wrapper drop-in compatible con supabase-js.
 *
 * Provee:
 *   - `pgPool`: pool de conexiones pg compartido (singleton).
 *   - `pgAdmin`: API mimética de `supabaseAdmin.from(...)` que ejecuta SQL.
 *
 * NO incluye `.auth` — eso sigue siendo Supabase Auth y se gestiona en
 * `lib/supabase.js`.
 *
 * Solo soporta los métodos usados en este proyecto (no es supabase-js
 * completo). Si se introduce un patrón nuevo (rpc, channels, etc.) habrá
 * que extender este wrapper.
 */

import pg from 'pg';

const { Pool } = pg;

// ── Pool singleton (sobrevive HMR en dev) ─────────────────────────────────────

const globalForPg = globalThis;

function buildPool() {
  const connStr = process.env.DATABASE_URL;
  if (!connStr) {
    throw new Error('[db] DATABASE_URL is not set');
  }
  return new Pool({
    connectionString: connStr,
    // Conexión sobre internet pública → exigir SSL.
    // `rejectUnauthorized: false` permite certs auto-firmados del VPS.
    ssl: process.env.DATABASE_SSL === 'false'
      ? false
      : { rejectUnauthorized: false },
    max: Number(process.env.DATABASE_POOL_MAX || 10),
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
  });
}

export const pgPool = globalForPg.__pgPool || (globalForPg.__pgPool = buildPool());

// ── Helpers ───────────────────────────────────────────────────────────────────

const ident = (name) => '"' + String(name).replace(/"/g, '""') + '"';

function parseColumns(cols) {
  // supabase-js permite "col1, col2" o "*". Acepta también
  // "col1, foreign_table(col)" pero NO soportamos joins implícitos.
  if (!cols || cols === '*') return '*';
  return cols
    .split(',')
    .map((c) => c.trim())
    .filter(Boolean)
    .map((c) => (c === '*' ? '*' : ident(c)))
    .join(', ');
}

function pgErrorShape(e) {
  // Imitar la shape de error de supabase-js (suficiente para el código actual)
  return { message: e?.message || String(e), code: e?.code || null, details: e?.detail || null };
}

/**
 * Encode a JS value for pg parameters.
 *
 * pg's default driver serializes JS arrays as Postgres ARRAY syntax
 * (`'{1,2,3}'`), which Postgres rejects for `jsonb` columns. We don't
 * have column-type info from the JS side, so we stringify any plain
 * object/array to JSON. Dates and Buffers pass through (pg handles
 * those natively).
 */
function encodeParam(v) {
  if (v === null || v === undefined) return v;
  if (v instanceof Date) return v;
  if (typeof Buffer !== 'undefined' && Buffer.isBuffer(v)) return v;
  if (Array.isArray(v) || (typeof v === 'object' && v.constructor === Object)) {
    return JSON.stringify(v);
  }
  return v;
}

// ── Query builder thenable ────────────────────────────────────────────────────

class PgQueryBuilder {
  constructor(table) {
    this.table = table;
    this._action = null;          // 'select' | 'insert' | 'update' | 'upsert' | 'delete'
    this._columns = '*';
    this._where = [];             // { col, op, val }
    this._orderBy = [];           // 'col DIR'
    this._limit = null;
    this._offset = null;
    this._values = null;          // insert/update/upsert
    this._onConflict = null;
    this._returning = false;      // RETURNING * después de write
    this._returnFirst = null;     // null | 'single' | 'maybeSingle'
    this._countMode = null;       // null | 'exact' | 'planned' | 'estimated'
    this._headOnly = false;
  }

  // ── Acciones ──
  select(cols = '*', opts = {}) {
    // Si ya hay una acción de write previa, .select() solo activa RETURNING.
    if (this._action && this._action !== 'select') {
      this._returning = true;
      // Columnas RETURNING (default *).
      this._columns = parseColumns(cols);
      if (opts.count) this._countMode = opts.count;
      if (opts.head) this._headOnly = true;
      return this;
    }
    this._action = 'select';
    this._columns = parseColumns(cols);
    if (opts.count) this._countMode = opts.count;
    if (opts.head) this._headOnly = true;
    return this;
  }

  insert(values) {
    this._action = 'insert';
    this._values = Array.isArray(values) ? values : [values];
    return this;
  }

  update(values) {
    this._action = 'update';
    this._values = values;
    return this;
  }

  upsert(values, opts = {}) {
    this._action = 'upsert';
    this._values = Array.isArray(values) ? values : [values];
    this._onConflict = opts.onConflict || null;
    return this;
  }

  delete() {
    this._action = 'delete';
    return this;
  }

  // ── Filtros ──
  eq(col, val)   { this._where.push({ col, op: '=',  val }); return this; }
  neq(col, val)  { this._where.push({ col, op: '<>', val }); return this; }
  gt(col, val)   { this._where.push({ col, op: '>',  val }); return this; }
  gte(col, val)  { this._where.push({ col, op: '>=', val }); return this; }
  lt(col, val)   { this._where.push({ col, op: '<',  val }); return this; }
  lte(col, val)  { this._where.push({ col, op: '<=', val }); return this; }
  in(col, arr)   { this._where.push({ col, op: 'IN', val: arr }); return this; }
  is(col, val)   { this._where.push({ col, op: 'IS', val }); return this; }
  not(col, op, val) { this._where.push({ col, op: 'NOT', subOp: op, val }); return this; }
  like(col, pat) { this._where.push({ col, op: 'LIKE', val: pat }); return this; }
  ilike(col, pat){ this._where.push({ col, op: 'ILIKE', val: pat }); return this; }

  // ── Modificadores ──
  order(col, opts = {}) {
    const dir = opts.ascending === false ? 'DESC' : 'ASC';
    const nulls = opts.nullsFirst === true ? 'NULLS FIRST'
                : opts.nullsFirst === false ? 'NULLS LAST'
                : '';
    this._orderBy.push(`${ident(col)} ${dir}${nulls ? ' ' + nulls : ''}`);
    return this;
  }
  limit(n) { this._limit = Number(n); return this; }
  range(from, to) {
    this._offset = Number(from);
    this._limit = Number(to) - Number(from) + 1;
    return this;
  }
  maybeSingle() { this._returnFirst = 'maybeSingle'; return this; }
  single()      { this._returnFirst = 'single'; return this; }

  // ── Execute (thenable) ──
  then(onResolve, onReject) {
    return this._execute().then(onResolve, onReject);
  }
  catch(onReject) { return this._execute().catch(onReject); }
  finally(fn)     { return this._execute().finally(fn); }

  async _execute() {
    try {
      switch (this._action) {
        case 'select': return await this._doSelect();
        case 'insert': return await this._doInsert();
        case 'update': return await this._doUpdate();
        case 'upsert': return await this._doUpsert();
        case 'delete': return await this._doDelete();
        default:
          return { data: null, error: { message: 'no action set' } };
      }
    } catch (e) {
      return { data: null, error: pgErrorShape(e), count: null, status: 500, statusText: 'error' };
    }
  }

  // ── Build WHERE ──
  _buildWhere(startParam = 1) {
    const params = [];
    const clauses = [];
    let idx = startParam;
    for (const w of this._where) {
      if (w.op === 'IN') {
        if (!Array.isArray(w.val) || w.val.length === 0) {
          clauses.push('FALSE');
          continue;
        }
        const placeholders = w.val.map(() => `$${idx++}`).join(', ');
        params.push(...w.val);
        clauses.push(`${ident(w.col)} IN (${placeholders})`);
      } else if (w.op === 'IS') {
        if (w.val === null) clauses.push(`${ident(w.col)} IS NULL`);
        else if (w.val === true || w.val === false) clauses.push(`${ident(w.col)} IS ${w.val ? 'TRUE' : 'FALSE'}`);
        else { params.push(w.val); clauses.push(`${ident(w.col)} IS $${idx++}`); }
      } else if (w.op === 'NOT') {
        // Sintaxis Supabase: .not(col, op, val) → "NOT (col OP val)" pero
        // hay casos especiales donde Postgres exige sintaxis literal.
        const sub = String(w.subOp || '').toLowerCase();
        if (sub === 'is') {
          if (w.val === null) { clauses.push(`${ident(w.col)} IS NOT NULL`); continue; }
          if (w.val === true || w.val === false) {
            clauses.push(`${ident(w.col)} IS NOT ${w.val ? 'TRUE' : 'FALSE'}`); continue;
          }
          params.push(w.val);
          clauses.push(`${ident(w.col)} IS NOT $${idx++}`);
          continue;
        }
        if (sub === 'in') {
          if (!Array.isArray(w.val) || w.val.length === 0) { clauses.push('TRUE'); continue; }
          const placeholders = w.val.map(() => `$${idx++}`).join(', ');
          params.push(...w.val);
          clauses.push(`${ident(w.col)} NOT IN (${placeholders})`);
          continue;
        }
        // Mapear operadores supabase a símbolos SQL (eq, neq, gt, gte, lt, lte)
        const SUB_OP_MAP = { eq: '=', neq: '<>', gt: '>', gte: '>=', lt: '<', lte: '<=', like: 'LIKE', ilike: 'ILIKE' };
        const sqlOp = SUB_OP_MAP[sub] || w.subOp;
        params.push(w.val);
        clauses.push(`NOT (${ident(w.col)} ${sqlOp} $${idx++})`);
      } else {
        params.push(w.val);
        clauses.push(`${ident(w.col)} ${w.op} $${idx++}`);
      }
    }
    return { sql: clauses.length ? ('WHERE ' + clauses.join(' AND ')) : '', params };
  }

  _buildOrderLimit() {
    let sql = '';
    if (this._orderBy.length) sql += ' ORDER BY ' + this._orderBy.join(', ');
    if (this._limit  != null) sql += ` LIMIT ${Number(this._limit)}`;
    if (this._offset != null) sql += ` OFFSET ${Number(this._offset)}`;
    return sql;
  }

  // ── SELECT ──
  async _doSelect() {
    const { sql: whereSql, params } = this._buildWhere(1);
    let count = null;

    if (this._countMode) {
      const countSql = `SELECT count(*)::bigint AS c FROM ${ident(this.table)} ${whereSql}`.trim();
      const { rows } = await pgPool.query(countSql, params);
      count = Number(rows[0]?.c ?? 0);
      if (this._headOnly) {
        return { data: null, error: null, count, status: 200, statusText: 'OK' };
      }
    }

    const sql = `SELECT ${this._columns} FROM ${ident(this.table)} ${whereSql} ${this._buildOrderLimit()}`.trim();
    const { rows } = await pgPool.query(sql, params);

    if (this._returnFirst === 'single') {
      if (rows.length === 0) return { data: null, error: { message: 'no rows', code: 'PGRST116' }, count, status: 406, statusText: 'no rows' };
      if (rows.length  >  1) return { data: null, error: { message: 'multiple rows', code: 'PGRST116' }, count, status: 406, statusText: 'multiple' };
      return { data: rows[0], error: null, count, status: 200, statusText: 'OK' };
    }
    if (this._returnFirst === 'maybeSingle') {
      return { data: rows[0] || null, error: null, count, status: 200, statusText: 'OK' };
    }
    return { data: rows, error: null, count, status: 200, statusText: 'OK' };
  }

  // ── INSERT ──
  async _doInsert() {
    if (!this._values?.length) return { data: null, error: null };
    const cols = Array.from(new Set(this._values.flatMap((r) => Object.keys(r))));
    const params = [];
    const rowsSql = this._values.map((r) => {
      const placeholders = cols.map((c) => {
        const v = r[c];
        if (v === undefined) return 'DEFAULT';
        params.push(encodeParam(v));
        return `$${params.length}`;
      });
      return `(${placeholders.join(', ')})`;
    });
    const returning = this._returning ? ` RETURNING ${this._columns}` : '';
    const sql = `INSERT INTO ${ident(this.table)} (${cols.map(ident).join(', ')}) VALUES ${rowsSql.join(', ')}${returning}`;
    const { rows } = await pgPool.query(sql, params);
    return this._shapeWriteResult(rows);
  }

  // ── UPDATE ──
  async _doUpdate() {
    const cols = Object.keys(this._values);
    if (!cols.length) return { data: null, error: null };
    const params = [];
    const setSql = cols.map((c) => { params.push(encodeParam(this._values[c])); return `${ident(c)} = $${params.length}`; }).join(', ');
    const { sql: whereSql, params: wParams } = this._buildWhere(params.length + 1);
    params.push(...wParams);
    const returning = this._returning ? ` RETURNING ${this._columns}` : '';
    const sql = `UPDATE ${ident(this.table)} SET ${setSql} ${whereSql}${returning}`;
    const { rows } = await pgPool.query(sql, params);
    return this._shapeWriteResult(rows);
  }

  // ── UPSERT ──
  async _doUpsert() {
    if (!this._values?.length) return { data: null, error: null };
    const cols = Array.from(new Set(this._values.flatMap((r) => Object.keys(r))));
    const params = [];
    const rowsSql = this._values.map((r) => {
      const placeholders = cols.map((c) => {
        const v = r[c];
        if (v === undefined) return 'DEFAULT';
        params.push(encodeParam(v));
        return `$${params.length}`;
      });
      return `(${placeholders.join(', ')})`;
    });

    // onConflict puede ser 'col' o 'col1,col2'
    const conflictCols = (this._onConflict || '')
      .split(',').map((s) => s.trim()).filter(Boolean);

    let conflictClause;
    if (conflictCols.length === 0) {
      // Sin target → DO NOTHING para evitar fallar por cualquier UNIQUE
      conflictClause = 'ON CONFLICT DO NOTHING';
    } else {
      const updateCols = cols.filter((c) => !conflictCols.includes(c));
      const setSql = updateCols.length
        ? updateCols.map((c) => `${ident(c)} = EXCLUDED.${ident(c)}`).join(', ')
        : null;
      conflictClause = `ON CONFLICT (${conflictCols.map(ident).join(', ')}) ${
        setSql ? `DO UPDATE SET ${setSql}` : 'DO NOTHING'
      }`;
    }
    const returning = this._returning ? ` RETURNING ${this._columns}` : '';
    const sql = `INSERT INTO ${ident(this.table)} (${cols.map(ident).join(', ')}) VALUES ${rowsSql.join(', ')} ${conflictClause}${returning}`;
    const { rows } = await pgPool.query(sql, params);
    return this._shapeWriteResult(rows);
  }

  // ── DELETE ──
  async _doDelete() {
    const { sql: whereSql, params } = this._buildWhere(1);
    if (!whereSql) {
      // Bloqueo de seguridad: nunca permitir DELETE sin WHERE
      return { data: null, error: { message: 'refusing DELETE without WHERE clause' } };
    }
    const returning = this._returning ? ` RETURNING ${this._columns}` : '';
    const sql = `DELETE FROM ${ident(this.table)} ${whereSql}${returning}`;
    const { rows } = await pgPool.query(sql, params);
    return this._shapeWriteResult(rows);
  }

  _shapeWriteResult(rows) {
    if (!this._returning) {
      return { data: null, error: null, status: 200, statusText: 'OK' };
    }
    if (this._returnFirst === 'single') {
      if (rows.length === 0) return { data: null, error: { message: 'no rows', code: 'PGRST116' } };
      if (rows.length  >  1) return { data: null, error: { message: 'multiple rows', code: 'PGRST116' } };
      return { data: rows[0], error: null };
    }
    if (this._returnFirst === 'maybeSingle') {
      return { data: rows[0] || null, error: null };
    }
    return { data: rows, error: null };
  }
}

// ── Punto de entrada estilo supabase-js ───────────────────────────────────────

export const pgAdmin = {
  from(table) { return new PgQueryBuilder(table); },
};

// ── Raw query escape hatch (para los pocos casos que lo necesiten) ────────────

export async function pgQuery(sql, params = []) {
  return pgPool.query(sql, params);
}
