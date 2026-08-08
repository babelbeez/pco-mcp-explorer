// OAuth 2.1 authorization-code + PKCE flow for a public browser client.
//   - authorization request includes the RFC 8707 resource indicator
//   - NO scope parameter: scope selection is provider-managed (PCO's consent
//     screen lets the user choose what to grant)
//   - token exchange is form-encoded with client_id + code_verifier, no secret

import { generateCodeChallenge, generateCodeVerifier, generateState } from './pkce';
import { ensureClientRegistration, forgetClientRegistration } from './dcr';
import type { DiscoveryResult } from './discovery';
import { cleanString, isRecord, type FetchLike } from './util';
import {
  clearPendingAuth,
  clearSession,
  loadPendingAuth,
  savePendingAuth,
  saveSession,
  type StoredSession,
} from './storage';

export class OAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OAuthError';
  }
}

export function buildAuthorizationUrl(
  discovery: DiscoveryResult,
  options: { clientId: string; redirectUri: string; state: string; codeChallenge: string },
): string {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: options.clientId,
    redirect_uri: options.redirectUri,
    code_challenge: options.codeChallenge,
    code_challenge_method: 'S256',
    state: options.state,
  });
  if (discovery.resource) {
    params.set('resource', discovery.resource);
  }
  // Deliberately no `scope` parameter: PCO manages scope selection on its own
  // consent screen (provider-managed scope policy).
  return `${discovery.authorizationEndpoint}?${params.toString()}`;
}

/** Registers the client (if needed), persists PKCE state, and returns the URL to redirect to. */
export async function prepareAuthorizationRedirect(
  discovery: DiscoveryResult,
  redirectUri: string,
  fetchImpl: FetchLike = fetch,
): Promise<string> {
  const clientId = await ensureClientRegistration(discovery.registrationEndpoint, redirectUri, fetchImpl);
  const codeVerifier = generateCodeVerifier();
  const codeChallenge = await generateCodeChallenge(codeVerifier);
  const state = generateState();
  savePendingAuth({ state, codeVerifier, clientId });
  return buildAuthorizationUrl(discovery, { clientId, redirectUri, state, codeChallenge });
}

export type CallbackParams =
  | { kind: 'code'; code: string; state: string }
  | { kind: 'error'; error: string; description: string | null }
  | null;

/** Interprets the current URL query string as an OAuth callback, if it is one. */
export function parseCallback(search: string): CallbackParams {
  const params = new URLSearchParams(search);
  const code = cleanString(params.get('code'));
  const state = cleanString(params.get('state'));
  const error = cleanString(params.get('error'));
  const errorDescription = cleanString(params.get('error_description'));

  if (error) return { kind: 'error', error, description: errorDescription };
  if (code && state) return { kind: 'code', code, state };
  return null;
}

/** Exchanges an authorization code for tokens and persists the session. */
export async function completeAuthorizationFlow(
  discovery: DiscoveryResult,
  code: string,
  state: string,
  redirectUri: string,
  fetchImpl: FetchLike = fetch,
): Promise<StoredSession> {
  const pending = loadPendingAuth();
  clearPendingAuth();
  if (!pending || pending.state !== state) {
    throw new OAuthError('Your sign-in state is missing or expired. Please connect again.');
  }

  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
    code_verifier: pending.codeVerifier,
    client_id: pending.clientId,
  });
  if (discovery.resource) {
    body.set('resource', discovery.resource);
  }

  let response: Response;
  try {
    response = await fetchImpl(discovery.tokenEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: body.toString(),
    });
  } catch {
    throw new OAuthError('Token exchange failed due to a network error. Please try again.');
  }

  if (!response.ok) {
    const payload: unknown = await response.json().catch(() => null);
    const oauthError = isRecord(payload) ? cleanString(payload.error) : null;
    if (oauthError === 'invalid_client') {
      // The cached DCR client_id is no longer accepted — drop it so the next
      // attempt registers a fresh client.
      forgetClientRegistration();
      throw new OAuthError('The app registration was rejected by Planning Center. Please try connecting again.');
    }
    if (oauthError === 'invalid_grant') {
      throw new OAuthError('The sign-in code expired or was already used. Please connect again.');
    }
    throw new OAuthError(`Token exchange failed (HTTP ${response.status}). Please try again.`);
  }

  const data: unknown = await response.json().catch(() => null);
  const accessToken = isRecord(data) ? cleanString(data.access_token) : null;
  if (!accessToken) {
    throw new OAuthError('Token exchange succeeded but no access token was returned.');
  }

  const tokenType = (isRecord(data) && cleanString(data.token_type)) || 'Bearer';
  const expiresIn = isRecord(data) && typeof data.expires_in === 'number' ? data.expires_in : null;
  const scope = isRecord(data) ? cleanString(data.scope) : null;

  const session: StoredSession = {
    accessToken,
    tokenType,
    clientId: pending.clientId,
    expiresAt: expiresIn !== null ? Date.now() + expiresIn * 1000 : null,
    scope,
  };
  saveSession(session);
  return session;
}

/** Best-effort token revocation (RFC 7009). Never throws. */
export async function revokeSession(
  discovery: DiscoveryResult,
  session: StoredSession,
  fetchImpl: FetchLike = fetch,
): Promise<void> {
  clearSession();
  if (!discovery.revocationEndpoint) return;
  try {
    await fetchImpl(discovery.revocationEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams({ token: session.accessToken, client_id: session.clientId }).toString(),
    });
  } catch {
    // Best effort only — local state is already cleared.
  }
}
