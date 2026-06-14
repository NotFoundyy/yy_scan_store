export type AuthUser = { id: string; username: string; isAdmin: boolean };
export type AuthSession = { accessToken: string; refreshToken: string; user: AuthUser };

const sessionKey = 'store-scan-auth-session';
const dataOwnerKey = 'store-scan-data-owner';
const eventName = 'store-scan-auth-changed';

export const getSession = (): AuthSession | undefined => {
  try {
    return JSON.parse(localStorage.getItem(sessionKey) || '') as AuthSession;
  } catch {
    return undefined;
  }
};

export const setSession = (session?: AuthSession, notify = true) => {
  if (session) localStorage.setItem(sessionKey, JSON.stringify(session));
  else localStorage.removeItem(sessionKey);
  if (notify) window.dispatchEvent(new Event(eventName));
};

export const getLocalDataOwner = () => localStorage.getItem(dataOwnerKey) || undefined;
export const setLocalDataOwner = (ownerId?: string) => {
  if (ownerId) localStorage.setItem(dataOwnerKey, ownerId);
  else localStorage.removeItem(dataOwnerKey);
};

export const onSessionChange = (listener: () => void) => {
  window.addEventListener(eventName, listener);
  return () => window.removeEventListener(eventName, listener);
};
