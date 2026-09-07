'use client';

import { useCallback } from 'react';
import { usePusherEvent } from '../../../lib/use-pusher';
import { applyFixtureDelta, mergeLiveStats } from './fixture-store';

export default function LiveStatsBridge({ children }) {
  usePusherEvent('live-scores', 'fixture-delta', useCallback((delta) => {
    applyFixtureDelta(delta);
  }, []));

  // Compatibilidad de despliegue: la web nueva se activa antes de reiniciar el
  // worker. Durante esos segundos todavía puede llegar el snapshot v1.
  usePusherEvent('live-scores', 'update', useCallback((payload) => {
    if (!Array.isArray(payload?.matches)) return;
    mergeLiveStats(Object.fromEntries(
      payload.matches.map((match) => [match.fixtureId, match]),
    ));
  }, []));

  usePusherEvent('live-scores', 'corners-update', useCallback((payload) => {
    if (!Array.isArray(payload?.matches)) return;
    mergeLiveStats(Object.fromEntries(
      payload.matches.map((match) => [match.fixtureId, match]),
    ));
  }, []));

  return children;
}
