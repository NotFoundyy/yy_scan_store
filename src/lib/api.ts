import type { AuthSession } from './auth';
import { getSession, setSession } from './auth';

export const apiBase = (import.meta.env.VITE_API_BASE_URL as string | undefined)?.replace(/\/$/, '') ?? '';

export class ApiError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

const request = async <T>(path: string, init: RequestInit = {}, retry = true): Promise<T> => {
  const session = getSession();
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 25000);
  let response: Response;
  try {
    const hasBody = init.body !== undefined && init.body !== null;
    response = await fetch(`${apiBase}${path}`, {
      ...init,
      signal: controller.signal,
      headers: {
        ...(hasBody ? { 'Content-Type': 'application/json' } : {}),
        ...init.headers,
        ...(session?.accessToken ? { Authorization: `Bearer ${session.accessToken}` } : {}),
      },
    });
  } catch (error) {
    throw new ApiError(controller.signal.aborted ? '服务器响应超时' : '无法连接服务器，请检查网络', 0);
  } finally {
    window.clearTimeout(timeout);
  }
  if (response.status === 401 && retry && session?.refreshToken && path !== '/auth/refresh') {
    try {
      const refreshed = await request<AuthSession>('/auth/refresh', {
        method: 'POST',
        body: JSON.stringify({ refreshToken: session.refreshToken }),
      }, false);
      setSession(refreshed);
      return request<T>(path, init, false);
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) setSession(undefined);
      throw error;
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
