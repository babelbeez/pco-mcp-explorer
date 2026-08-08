import { describe, expect, it } from 'vitest';

import { buildAuthorizationUrl, parseCallback } from '../src/lib/oauth';
import type { DiscoveryResult } from '../src/lib/discovery';

const discovery: DiscoveryResult = {
  serverUrl: 'https://mcp.planningcenteronline.com/mcp',
  resource: 'https://mcp.planningcenteronline.com/mcp',
  issuer: 'https://mcp.planningcenteronline.com',
  authorizationEndpoint: 'https://mcp.planningcenteronline.com/authorize',
  tokenEndpoint: 'https://mcp.planningcenteronline.com/token',
  registrationEndpoint: 'https://mcp.planningcenteronline.com/register',
  revocationEndpoint: 'https://mcp.planningcenteronline.com/revoke',
  scopesSupported: ['mcp:read', 'mcp:people:read'],
};

describe('buildAuthorizationUrl', () => {
  it('builds a PKCE authorization request with the RFC 8707 resource indicator', () => {
    const url = new URL(
      buildAuthorizationUrl(discovery, {
        clientId: 'client-123',
        redirectUri: 'https://babelbeez.github.io/pco-mcp-explorer/',
        state: 'state-abc',
        codeChallenge: 'challenge-xyz',
      }),
    );

    expect(url.origin + url.pathname).toBe('https://mcp.planningcenteronline.com/authorize');
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('client_id')).toBe('client-123');
    expect(url.searchParams.get('redirect_uri')).toBe('https://babelbeez.github.io/pco-mcp-explorer/');
    expect(url.searchParams.get('code_challenge')).toBe('challenge-xyz');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('state')).toBe('state-abc');
    expect(url.searchParams.get('resource')).toBe('https://mcp.planningcenteronline.com/mcp');
  });

  it('never sends a scope parameter (provider-managed scope selection)', () => {
    const url = buildAuthorizationUrl(discovery, {
      clientId: 'client-123',
      redirectUri: 'https://example.com/',
      state: 's',
      codeChallenge: 'c',
    });
    expect(new URL(url).searchParams.has('scope')).toBe(false);
  });

  it('omits resource when the server does not advertise one', () => {
    const url = buildAuthorizationUrl({ ...discovery, resource: null }, {
      clientId: 'client-123',
      redirectUri: 'https://example.com/',
      state: 's',
      codeChallenge: 'c',
    });
    expect(new URL(url).searchParams.has('resource')).toBe(false);
  });
});

describe('parseCallback', () => {
  it('parses a successful callback', () => {
    expect(parseCallback('?code=abc&state=xyz')).toEqual({ kind: 'code', code: 'abc', state: 'xyz' });
  });

  it('parses an error callback', () => {
    expect(parseCallback('?error=access_denied&error_description=nope')).toEqual({
      kind: 'error',
      error: 'access_denied',
      description: 'nope',
    });
  });

  it('returns null for unrelated query strings', () => {
    expect(parseCallback('')).toBeNull();
    expect(parseCallback('?foo=bar')).toBeNull();
    expect(parseCallback('?code=abc')).toBeNull();
  });
});
