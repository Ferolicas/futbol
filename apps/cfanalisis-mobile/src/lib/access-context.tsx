import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { AppState } from 'react-native';
import { api } from './api';
import { useAuth } from './auth-context';
import { randomUUID } from './format';

// Free vs Pro. El servidor es la única autoridad (hasActiveEntitlement); aquí
// solo replicamos la señal que el propio backend nos devuelve:
//   - /api/auth/session: role + subscription_status (estimación inmediata).
//   - POST /api/free/visit: {paid:true} confirma acceso completo; {paid:false,
//     showPlans} decide si mostrar el selector de planes (visitas 1, 4, 7…).
interface AccessContextValue {
  isFree: boolean;
  resolved: boolean;
  plansOpen: boolean;
  openPlans: () => void;
  closePlans: () => void;
  refreshAccess: () => Promise<void>;
}

const AccessContext = createContext<AccessContextValue>({
  isFree: true, resolved: false, plansOpen: false, openPlans: () => {}, closePlans: () => {}, refreshAccess: async () => {},
});

export const useAccess = () => useContext(AccessContext);

function estimateFree(user: { role?: string | null; subscription_status?: string | null } | null) {
  if (!user) return true;
  if (['admin', 'owner'].includes(String(user.role))) return false;
  return !['active', 'trialing'].includes(String(user.subscription_status));
}

export function AccessProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const [isFree, setIsFree] = useState(() => estimateFree(user));
  const [resolved, setResolved] = useState(false);
  const [plansOpen, setPlansOpen] = useState(false);
  const visitRef = useRef<{ id: string; lastSeen: number; reported: boolean; dismissed: boolean } | null>(null);
  const busyRef = useRef(false);

  useEffect(() => {
    setIsFree(estimateFree(user));
    setResolved(false);
    visitRef.current = null;
  }, [user?.id, user?.subscription_status, user?.role]);

  const visit = useCallback(async () => {
    if (!user || busyRef.current) return;
    const now = Date.now();
    let saved = visitRef.current;
    if (!saved || now - saved.lastSeen > 30 * 60_000) {
      saved = { id: randomUUID(), lastSeen: now, reported: false, dismissed: false };
    }
    saved.lastSeen = now;
    visitRef.current = saved;
    if (saved.reported) return;
    busyRef.current = true;
    try {
      const result = await api.post<{ paid: boolean; showPlans?: boolean }>('/api/free/visit', { visitId: saved.id });
      saved.reported = true;
      setIsFree(!result.paid);
      setResolved(true);
      if (!result.paid && result.showPlans && !saved.dismissed) setPlansOpen(true);
    } catch {
      // El acceso nunca depende de este aviso comercial.
    } finally {
      busyRef.current = false;
    }
  }, [user]);

  useEffect(() => {
    if (!user) return;
    const initial = setTimeout(visit, 1500);
    const timer = setInterval(visit, 60_000);
    const sub = AppState.addEventListener('change', (state) => { if (state === 'active') visit(); });
    return () => { clearTimeout(initial); clearInterval(timer); sub.remove(); };
  }, [user, visit]);

  const refreshAccess = useCallback(async () => {
    if (visitRef.current) visitRef.current.reported = false;
    await visit();
  }, [visit]);

  const value = useMemo<AccessContextValue>(() => ({
    isFree,
    resolved,
    plansOpen,
    openPlans: () => setPlansOpen(true),
    closePlans: () => {
      setPlansOpen(false);
      if (visitRef.current) visitRef.current.dismissed = true;
    },
    refreshAccess,
  }), [isFree, resolved, plansOpen, refreshAccess]);

  return <AccessContext.Provider value={value}>{children}</AccessContext.Provider>;
}
