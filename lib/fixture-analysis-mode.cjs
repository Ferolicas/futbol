'use strict';

const NOT_STARTED_STATUSES = new Set(['NS', 'TBD']);

/**
 * Decide si la tarjeta debe leer el snapshot prepartido compatible (v24+)
 * en vez de exigir el contrato vigente.
 *
 * La fecha seleccionada no basta: por diferencias de zona horaria, una
 * jornada que todavía es "hoy" puede contener partidos que ya comenzaron o
 * que fueron almacenados por el worker bajo el día colombiano anterior.
 */
function fixtureUsesHistoricalSnapshot(fixture, { isPastDate = false, nowMs = Date.now() } = {}) {
  if (isPastDate) return true;

  const status = String(fixture?.fixture?.status?.short || '').trim().toUpperCase();
  if (status && !NOT_STARTED_STATUSES.has(status)) return true;

  const kickoffMs = new Date(fixture?.fixture?.date || '').getTime();
  return Number.isFinite(kickoffMs) && kickoffMs <= nowMs;
}

module.exports = { fixtureUsesHistoricalSnapshot };
