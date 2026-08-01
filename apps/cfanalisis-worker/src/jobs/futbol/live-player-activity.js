// Actividad individual observable durante un partido.
//
// API-Football no publica remates ni faltas como eventos discretos con minuto,
// pero sí entrega contadores acumulados por jugador en `fixtures[].players`.
// Comparar dos snapshots consecutivos permite atribuir el incremento a un
// jugador sin inventar información. Los jugadores nuevos se usan como baseline
// y no generan eventos retroactivos.

function counter(value) {
  if (value === null || value === undefined || value === '') return 0;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 0;
}

export const FIXTURE_DETAIL_BATCH_SIZE = 20;

// API-Football admite hasta 20 IDs en `/fixtures?ids=id-id-...`. Centralizar
// aquí el particionado evita volver al patrón costoso de una llamada por
// partido cuando haya cientos de encuentros en el día.
export function fixtureDetailBatches(fixturesOrIds, batchSize = FIXTURE_DETAIL_BATCH_SIZE) {
  const safeSize = Math.max(1, Math.min(FIXTURE_DETAIL_BATCH_SIZE, Math.floor(Number(batchSize)) || FIXTURE_DETAIL_BATCH_SIZE));
  const ids = [...new Set((fixturesOrIds || [])
    .map(value => Number(value?.fixture?.id ?? value))
    .filter(value => Number.isFinite(value) && value > 0))];
  const batches = [];
  for (let i = 0; i < ids.length; i += safeSize) batches.push(ids.slice(i, i + safeSize));
  return batches;
}

export function playerActivityKey(row) {
  if (row?.key) return String(row.key);
  if (row?.playerId != null) return `id:${row.playerId}`;
  const team = row?.teamId ?? 'team';
  const name = encodeURIComponent(String(row?.player || '').trim().toLowerCase());
  return `name:${team}:${name}`;
}

export function extractPlayerActivity(teamBlocks) {
  if (!Array.isArray(teamBlocks)) return [];
  const rows = [];

  for (const block of teamBlocks) {
    const teamId = block?.team?.id ?? null;
    const teamName = block?.team?.name || null;
    for (const entry of (block?.players || [])) {
      const playerId = entry?.player?.id ?? null;
      const player = entry?.player?.name || null;
      if (playerId == null && !player) continue;
      const stats = entry?.statistics?.[0] || {};
      const row = {
        playerId,
        player,
        teamId,
        teamName,
        shots: counter(stats?.shots?.total),
        shotsOnTarget: counter(stats?.shots?.on),
        fouls: counter(stats?.fouls?.committed),
      };
      row.key = playerActivityKey(row);
      rows.push(row);
    }
  }

  return rows;
}

// Si una liga devuelve temporalmente solo uno de los equipos, conservamos el
// último contador del bloque ausente. Un snapshot parcial nunca debe convertir
// a sus jugadores en "nuevos" en el siguiente minuto.
export function mergePlayerActivity(previous, current) {
  const merged = new Map();
  for (const row of (previous || [])) merged.set(playerActivityKey(row), row);
  for (const row of (current || [])) {
    const key = playerActivityKey(row);
    const was = merged.get(key);
    if (!was) {
      merged.set(key, row);
      continue;
    }

    // Los contadores dentro de un partido son monótonos. API-Football puede
    // devolver temporalmente un valor inferior o null en un tick parcial; si
    // lo aceptáramos, el regreso al valor real en el tick siguiente parecería
    // una acción nueva y produciría un push falso.
    merged.set(key, {
      ...was,
      ...row,
      key,
      shots: Math.max(counter(was.shots), counter(row.shots)),
      shotsOnTarget: Math.max(counter(was.shotsOnTarget), counter(row.shotsOnTarget)),
      fouls: Math.max(counter(was.fouls), counter(row.fouls)),
    });
  }
  return [...merged.values()];
}

export function diffPlayerActivity(previous, current) {
  const before = new Map((previous || []).map(row => [playerActivityKey(row), row]));
  const changes = [];

  for (const now of (current || [])) {
    const key = playerActivityKey(now);
    const was = before.get(key);
    // Sin baseline individual no sabemos cuándo ocurrió el acumulado.
    if (!was) continue;

    const totalShotsDelta = Math.max(0, counter(now.shots) - counter(was.shots));
    const onTargetDelta = Math.max(0, counter(now.shotsOnTarget) - counter(was.shotsOnTarget));
    const otherShotsDelta = Math.max(0, totalShotsDelta - onTargetDelta);
    const foulsDelta = Math.max(0, counter(now.fouls) - counter(was.fouls));
    const identity = {
      playerKey: key,
      playerId: now.playerId ?? null,
      player: now.player || 'Jugador no informado',
      teamId: now.teamId ?? null,
      teamName: now.teamName || 'Equipo no informado',
    };

    if (onTargetDelta > 0) {
      changes.push({
        ...identity,
        type: 'shot_on_target',
        count: onTargetDelta,
        counter: counter(now.shotsOnTarget),
      });
    }
    if (otherShotsDelta > 0) {
      changes.push({
        ...identity,
        type: 'shot',
        count: otherShotsDelta,
        counter: counter(now.shots),
      });
    }
    if (foulsDelta > 0) {
      changes.push({
        ...identity,
        type: 'foul',
        count: foulsDelta,
        counter: counter(now.fouls),
      });
    }
  }

  return changes;
}
