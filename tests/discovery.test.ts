import { describe, expect, it } from 'vitest';

import { discoverProviderMetadata, DiscoveryError } from '../src/lib/discovery';
import type { FetchLike } from '../src/lib/util';

const SERVER = 'https://mcp.planningcenteronline.com/mcp';
const ORIGIN = 'https://mcp.planningcenteronline.com';

// Mirrors the real PCO responses (probed 2026-08).
const PROTECTED_RESOURCE = {
  resource: SERVER,
  authorization_servers: [ORIGIN],
  scopes_supported: ['mcp:read', 'mcp:write', 'mcp:people:read'],
  bearer_methods_supported: ['header'],
};

const AUTH_SERVER = {
  issuer: ORIGIN,
  authorization_endpoint: `${ORIGIN}/authorize`,
  token_endpoint: `${ORIGIN}/token`,
  registration_endpoint: `${ORIGIN}/register`,
  revocation_endpoint: `${ORIGIN}/revoke`,
  scopes_supported: PROTECTED_RESOURCE.scopes_supported,
  response_types_supported: ['code'],
  grant_types_supported: ['refresh_token', 'authorization_code'],
  token_endpoint_auth_methods_supported: ['none'],
  code_challenge_methods_supported: ['S256'],
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function fixtureFetch(routes: Record<string, Response>): FetchLike {
  return async (input) => {
    const response = routes[input];
    if (!response) return new Response('not found', { status: 404 });
    return response;
  };
}

const happyFetch = fixtureFetch({
  [`${ORIGIN}/.well-known/oauth-protected-resource/mcp`]: jsonResponse(PROTECTED_RESOURCE),
  [`${ORIGIN}/.well-known/oauth-authorization-server`]: jsonResponse(AUTH_SERVER),
});

describe('discoverProviderMetadata', () => {
  it('discovers and validates the full PCO metadata chain', async () => {
    const result = await discoverProviderMetadata(SERVER, happyFetch);
    expect(result.resource).toBe(SERVER);
    expect(result.authorizationEndpoint).toBe(`${ORIGIN}/authorize`);
    expect(result.tokenEndpoint).toBe(`${ORIGIN}/token`);
    expect(result.registrationEndpoint).toBe(`${ORIGIN}/register`);
    expect(result.revocationEndpoint).toBe(`${ORIGIN}/revoke`);
    expect(result.scopesSupported).toContain('mcp:people:read');
  });

  it('falls back to the root well-known location', async () => {
    const fetchImpl = fixtureFetch({
      [`${ORIGIN}/.well-known/oauth-protected-resource`]: jsonResponse(PROTECTED_RESOURCE),
      [`${ORIGIN}/.well-known/oauth-authorization-server`]: jsonResponse(AUTH_SERVER),
    });
    const result = await discoverProviderMetadata(SERVER, fetchImpl);
    expect(result.tokenEndpoint).toBe(`${ORIGIN}/token`);
  });

  it('fails closed when no registration endpoint is advertised', async () => {
    const fetchImpl = fixtureFetch({
      [`${ORIGIN}/.well-known/oauth-protected-resource/mcp`]: jsonResponse(PROTECTED_RESOURCE),
      [`${ORIGIN}/.well-known/oauth-authorization-server`]: jsonResponse({
        ...AUTH_SERVER,
        registration_endpoint: undefined,
      }),
    });
    await expect(discoverProviderMetadata(SERVER, fetchImpl)).rejects.toBeInstanceOf(DiscoveryError);
  });

  it('fails closed without S256 PKCE support', async () => {
    const fetchImpl = fixtureFetch({
      [`${ORIGIN}/.well-known/oauth-protected-resource/mcp`]: jsonResponse(PROTECTED_RESOURCE),
      [`${ORIGIN}/.well-known/oauth-authorization-server`]: jsonResponse({
        ...AUTH_SERVER,
        code_challenge_methods_supported: ['plain'],
      }),
    });
    await expect(discoverProviderMetadata(SERVER, fetchImpl)).rejects.toThrow(/PKCE/);
  });

  it('fails closed when confidential clients are required', async () => {
    const fetchImpl = fixtureFetch({
      [`${ORIGIN}/.well-known/oauth-protected-resource/mcp`]: jsonResponse(PROTECTED_RESOURCE),
      [`${ORIGIN}/.well-known/oauth-authorization-server`]: jsonResponse({
        ...AUTH_SERVER,
        token_endpoint_auth_methods_supported: ['client_secret_basic'],
      }),
    });
    await expect(discoverProviderMetadata(SERVER, fetchImpl)).rejects.toThrow(/confidential/);
  });

  it('refuses cross-host OAuth endpoints', async () => {
    const fetchImpl = fixtureFetch({
      [`${ORIGIN}/.well-known/oauth-protected-resource/mcp`]: jsonResponse(PROTECTED_RESOURCE),
      [`${ORIGIN}/.well-known/oauth-authorization-server`]: jsonResponse({
        ...AUTH_SERVER,
        token_endpoint: 'https://evil.example.com/token',
      }),
    });
    await expect(discoverProviderMetadata(SERVER, fetchImpl)).rejects.toThrow(/different host/);
  });

  it('fails with a readable error when discovery finds nothing', async () => {
    const fetchImpl: FetchLike = async () => new Response('nope', { status: 404 });
    await expect(discoverProviderMetadata(SERVER, fetchImpl)).rejects.toThrow(/RFC 9728/);
  });
});
