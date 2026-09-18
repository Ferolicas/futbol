import { API_URL } from './config';
import { getSessionToken, parseSessionCookie, sessionCookieHeader, setSessionToken } from './session';

export class ApiError extends Error {
  status: number;
  info: unknown;
  constructor(message: string, status: number, info?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.info = info;
  }
}

type Json = Record<string, unknown> | unknown[] | null;

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
  headers?: Record<string, string>;
  timeoutMs?: number;
  /** Si es true no lanza en 401 (p.ej. /api/auth/session devuelve {user:null}). */
  allowUnauthorized?: boolean;
}

type UnauthorizedListener = () => void;
const unauthorizedListeners = new Set<UnauthorizedListener>();

/** Permite al AuthProvider reaccionar cuando el backend revoca la sesión. */
export function onUnauthorized(listener: UnauthorizedListener) {
  unauthorizedListeners.add(listener);
  return () => { unauthorizedListeners.delete(listener); };
}

async function readBody(response: Response): Promise<Json | string | null> {
  const text = await response.text().catch(() => '');
  if (!text) return null;
  try { return JSON.parse(text); } catch { return text; }
}

export async function apiFetch<T = any>(path: string, options: RequestOptions = {}): Promise<T> {
  const { method = 'GET', body, headers = {}, timeoutMs = 25_000, allowUnauthorized = false } = options;
  const token = await getSessionToken();
  const cookie = sessionCookieHeader(token);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response: Response;
  try {
    response = await fetch(`${API_URL}${path}`, {
      method,
      // `omit`: no usamos el cookie-jar nativo; la sesión viaja siempre de forma
      // explícita desde SecureStore para que sea determinista en iOS y Android.
      credentials: 'omit',
      headers: {
        Accept: 'application/json',
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(cookie ? { Cookie: cookie } : {}),
        ...headers,
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
  } catch (error: any) {
    clearTimeout(timer);
    if (error?.name === 'AbortError') throw new ApiError('Tiempo de espera agotado', 0);
    throw new ApiError('Sin conexión con el servidor', 0);
  }
  clearTimeout(timer);

  // Login/registro emiten la cookie de sesión; la conservamos como token.
  const setCookie = response.headers.get('set-cookie');
  const fresh = parseSessionCookie(setCookie);
  if (fresh && fresh !== token) await setSessionToken(fresh);

  const payload = await readBody(response);
  if (response.status === 401 && !allowUnauthorized) {
    for (const listener of unauthorizedListeners) listener();
    throw new ApiError('Sesión no válida', 401, payload);
  }
  if (!response.ok) {
    const message = (payload && typeof payload === 'object' && 'error' in payload && typeof (payload as any).error === 'string')
      ? (payload as any).error
      : `HTTP ${response.status}`;
    throw new ApiError(message, response.status, payload);
  }
  return payload as T;
}

/** Fetcher para SWR: `useSWR('/api/fixtures?...', swrFetcher)`. */
export const swrFetcher = <T = any>(path: string) => apiFetch<T>(path);

export const api = {
  get: <T = any>(path: string, options?: Omit<RequestOptions, 'method' | 'body'>) => apiFetch<T>(path, { ...options, method: 'GET' }),
  post: <T = any>(path: string, body?: unknown, options?: Omit<RequestOptions, 'method' | 'body'>) => apiFetch<T>(path, { ...options, method: 'POST', body: body ?? {} }),
  put: <T = any>(path: string, body?: unknown, options?: Omit<RequestOptions, 'method' | 'body'>) => apiFetch<T>(path, { ...options, method: 'PUT', body: body ?? {} }),
  patch: <T = any>(path: string, body?: unknown, options?: Omit<RequestOptions, 'method' | 'body'>) => apiFetch<T>(path, { ...options, method: 'PATCH', body: body ?? {} }),
  delete: <T = any>(path: string, body?: unknown, options?: Omit<RequestOptions, 'method' | 'body'>) => apiFetch<T>(path, { ...options, method: 'DELETE', body }),
};
