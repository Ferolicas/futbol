'use client';

import useSWR from 'swr';
import { fetcher } from '../lib/fetcher';

/**
 * Lista de combinadas guardadas del usuario.
 *
 * Por que SWR aqui (y no useEffect manual):
 *   - revalida automaticamente al volver el foco a la pestana
 *   - dedup de requests en multiples componentes
 *   - mutate optimista facil para save/delete
 *
 * Refresh interval: ninguno por defecto — el usuario actua sobre ellas
 * (anadir/borrar), no son datos volatiles que cambien solos.
 */
export function useSavedCombinadas() {
  const { data, error, mutate, isLoading } = useSWR('/api/user?type=combinadas', fetcher, {
    revalidateOnFocus: true,
    revalidateOnReconnect: true,
    dedupingInterval: 5000,
  });
  const list = Array.isArray(data?.combinadas) ? data.combinadas : [];
  return { combinadas: list, error, mutate, isLoading };
}
