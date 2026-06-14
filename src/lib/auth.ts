export type AuthUser = { id: string; username: string };
export type AuthSession = { accessToken: string; refreshToken: string; user: AuthUser };

const sessionKey = 'store-scan-auth-session';
const eventName = 'store-scan-auth-changed';

export const getSession = (): AuthSession | undefined => {
  try {
    return JSON.parse(localStorage.getItem(sessionKey) || '') as AuthSession;
  } catch {
    return undefined;
  }
};

export const setSession = (session?: AuthSession) => {
  if (session) localStorage.setItem(sessionKey, JSON.stringify(session));
  else localStorage.removeItem(sessionKey);
  window.dispatchEvent(new Event(eventName));
};

export const onSessionChange = (listener: () => void) => {
  window.addEventListener(eventName, listener);
  return () => window.removeEventListener(eventName, listener);
};
