// Browser storage for OAuth state. Everything stays client-side:
// - sessionStorage holds the access token and in-flight PKCE state (tab-scoped).
// - localStorage holds only the Dynamic Client Registration record (client_id),
//   which is not a secret — PCO registers public clients (token_endpoint_auth_method: none).

import { isRecord, cleanString } from './util';

const SESSION_KEY = 'pco-mcp-explorer:session';
const PENDING_AUTH_KEY = 'pco-mcp-explorer:pending-auth';
const DCR_KEY = 'pco-mcp-explorer:dcr-registration';

export interface StoredSession {
  accessToken: string;
  tokenType: string;
  clientId: string;
  /** Epoch milliseconds, or null when the provider did not return expires_in. */
  expiresAt: number | null;
  /** Space-separated granted scopes as returned by the token endpoint, if any. */
  scope: string | null;
}

export interface PendingAuth {
  state: string;
  codeVerifier: string;
  clientId: string;
}

export interface DcrRegistration {
  clientId: string;
  redirectUri: string;
  registeredAt: string;
}

function safeSessionStorage(): Storage | null {
  try {
    return typeof sessionStorage === 'undefined' ? null : sessionStorage;
  } catch {
    return null;
  }
}

function safeLocalStorage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

function readJson<T>(storage: Storage | null, key: string): T | null {
  if (!storage) return null;
  const raw = storage.getItem(key);
  if (!raw) return null;
  try {
    const value: unknown = JSON.parse(raw);
    return isRecord(value) ? (value as T) : null;
  } catch {
    return null;
  }
}

export function saveSession(session: StoredSession): void {
  safeSessionStorage()?.setItem(SESSION_KEY, JSON.stringify(session));
}

export function loadSession(): StoredSession | null {
  const value = readJson<StoredSession>(safeSessionStorage(), SESSION_KEY);
  if (!value || !cleanString(value.accessToken) || !cleanString(value.clientId)) return null;
  return value;
}

export function clearSession(): void {
  safeSessionStorage()?.removeItem(SESSION_KEY);
}

/** True when the session token is expired (with a 30s skew) or unusable. */
export function isSessionExpired(session: StoredSession): boolean {
  if (session.expiresAt === null) return false;
  return Date.now() >= session.expiresAt - 30_000;
}

export function savePendingAuth(pending: PendingAuth): void {
  safeSessionStorage()?.setItem(PENDING_AUTH_KEY, JSON.stringify(pending));
}

export function loadPendingAuth(): PendingAuth | null {
  const value = readJson<PendingAuth>(safeSessionStorage(), PENDING_AUTH_KEY);
  if (!value || !cleanString(value.state) || !cleanString(value.codeVerifier) || !cleanString(value.clientId)) {
    return null;
  }
  return value;
}

export function clearPendingAuth(): void {
  safeSessionStorage()?.removeItem(PENDING_AUTH_KEY);
}

export function loadDcrRegistration(): DcrRegistration | null {
  const value = readJson<DcrRegistration>(safeLocalStorage(), DCR_KEY);
  if (!value || !cleanString(value.clientId) || !cleanString(value.redirectUri)) return null;
  return value;
}

export function saveDcrRegistration(registration: DcrRegistration): void {
  safeLocalStorage()?.setItem(DCR_KEY, JSON.stringify(registration));
}

export function clearDcrRegistration(): void {
  safeLocalStorage()?.removeItem(DCR_KEY);
}
