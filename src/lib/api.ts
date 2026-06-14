import type { AuthSession } from './auth';
import { getSession, setSession } from './auth';

const apiBase = (import.meta.env.VITE_API_BASE_URL as string | undefined)?.replace(/\/$/, '') ?? '';

export class ApiError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

const request = async <T>(path: string, init: RequestInit = {}, retry = true): Promise<T> => {
  const session = getSession();
  const response = await fetch(`${apiBase}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...init.headers,
      ...(session?.accessToken ? { Authorization: `Bearer ${session.accessToken}` } : {}),
    },
  });
  if (response.status === 401 && retry && session?.refreshToken && path !== '/auth/refresh') {
    try {
      const refreshed = await request<AuthSession>('/auth/refresh', {
        method: 'POST',
        body: JSON.stringify({ refreshToken: session.refreshToken }),
      }, false);
      setSession(refreshed);
      return request<T>(path, init, false);
    } catch {
      setSession(undefined);
    }
  }
  if (!response.ok) {
    const body = await response.json().catch(() => ({})) as { message?: string };
    throw new ApiError(body.message || `请求失败 (${response.status})`, response.status);
  }
  return response.json() as Promise<T>;
};

export const api = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, body?: unknown) => request<T>(path, { method: 'POST', body: JSON.stringify(body ?? {}) }),
  patch: <T>(path: string, body: unknown) => request<T>(path, { method: 'PATCH', body: JSON.stringify(body) }),
  delete: <T>(path: string) => request<T>(path, { method: 'DELETE' }),
};

export const hasApiConfiguration = () => Boolean(apiBase);
