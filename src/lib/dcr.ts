// RFC 7591 Dynamic Client Registration for a browser-based public client.
// The registration (client_id) is cached in localStorage keyed by redirect URI;
// it is not a secret — PCO issues public clients (token_endpoint_auth_method: none).

import { CLIENT_HOMEPAGE, CLIENT_NAME } from '../config';
import { cleanString, isRecord, type FetchLike } from './util';
import { loadDcrRegistration, saveDcrRegistration, clearDcrRegistration } from './storage';

export class DcrError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DcrError';
  }
}

/** Returns a cached client_id for this redirect URI, registering a new client if needed. */
export async function ensureClientRegistration(
  registrationEndpoint: string,
  redirectUri: string,
  fetchImpl: FetchLike = fetch,
): Promise<string> {
  const cached = loadDcrRegistration();
  if (cached && cached.redirectUri === redirectUri) {
    return cached.clientId;
  }
  return registerNewClient(registrationEndpoint, redirectUri, fetchImpl);
}

/** Registers a fresh public client and caches it. */
export async function registerNewClient(
  registrationEndpoint: string,
  redirectUri: string,
  fetchImpl: FetchLike = fetch,
): Promise<string> {
  let response: Response;
  try {
    response = await fetchImpl(registrationEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        client_name: CLIENT_NAME,
        client_uri: CLIENT_HOMEPAGE,
        redirect_uris: [redirectUri],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
      }),
    });
  } catch {
    throw new DcrError('Dynamic client registration failed due to a network error. Please try again.');
  }

  if (!response.ok) {
    // Surface the provider's own explanation (e.g. OAuth error_description) so
    // registration policy issues are diagnosable without a network inspector.
    const payload: unknown = await response.json().catch(() => null);
    const detail = isRecord(payload) ? cleanString(payload.error_description) : null;
    throw new DcrError(
      detail
        ? `Dynamic client registration was rejected: ${detail}`
        : `Dynamic client registration was rejected (HTTP ${response.status}).`,
    );
  }

  const data: unknown = await response.json().catch(() => null);
  const clientId = isRecord(data) ? cleanString(data.client_id) : null;
  if (!clientId) {
    throw new DcrError('Dynamic client registration succeeded but returned no client_id.');
  }

  saveDcrRegistration({ clientId, redirectUri, registeredAt: new Date().toISOString() });
  return clientId;
}

/** Drops the cached registration (used after an invalid_client response). */
export function forgetClientRegistration(): void {
  clearDcrRegistration();
}
