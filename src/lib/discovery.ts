// OAuth discovery for MCP servers, ported from the proven Babelbeez backend flow:
//   1. RFC 9728 protected-resource metadata (with WWW-Authenticate challenge fallback)
//   2. Authorization Server metadata (RFC 8414 / OIDC discovery)
//   3. Fail-closed validation for browser-based public-client use.

import { cleanString, dedupe, isRecord, type FetchLike } from './util';

export class DiscoveryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DiscoveryError';
  }
}

export interface DiscoveryResult {
  serverUrl: string;
  /** RFC 8707 resource indicator advertised by the protected-resource metadata. */
  resource: string | null;
  issuer: string | null;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  registrationEndpoint: string;
  revocationEndpoint: string | null;
  scopesSupported: string[];
}

async function fetchJsonObject(url: string, fetchImpl: FetchLike): Promise<Record<string, unknown> | null> {
  try {
    const response = await fetchImpl(url, { headers: { Accept: 'application/json' } });
    if (!response.ok) return null;
    const data: unknown = await response.json();
    return isRecord(data) ? data : null;
  } catch {
    return null;
  }
}

/** Reads the resource_metadata URL out of a Bearer challenge, if present. */
function parseResourceMetadataUrl(header: string | null): string | null {
  if (!header || !/^Bearer\s/i.test(header)) return null;
  const match = header.match(/resource_metadata="([^"]+)"/i);
  return match ? cleanString(match[1]) : null;
}

/** Fallback: probe the server for a WWW-Authenticate challenge carrying the metadata URL. */
async function probeResourceMetadataUrl(serverUrl: string, fetchImpl: FetchLike): Promise<string | null> {
  try {
    const response = await fetchImpl(serverUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 'discovery-probe', method: 'ping' }),
    });
    return parseResourceMetadataUrl(response.headers.get('www-authenticate'));
  } catch {
    return null;
  }
}

function requireEndpoint(metadata: Record<string, unknown>, key: string, what: string): string {
  const value = cleanString(metadata[key]);
  if (!value) {
    throw new DiscoveryError(`The MCP server's authorization metadata is missing ${what} (${key}).`);
  }
  return value;
}

function assertSameOrigin(endpoint: string, serverOrigin: string, what: string): void {
  let origin: string;
  try {
    origin = new URL(endpoint).origin;
  } catch {
    throw new DiscoveryError(`The ${what} advertised by the MCP server is not a valid URL.`);
  }
  if (origin !== serverOrigin) {
    throw new DiscoveryError(
      `The ${what} is on a different host than the MCP server. This tool does not follow cross-host OAuth metadata.`,
    );
  }
}

/**
 * Discovers and validates everything needed to run an OAuth 2.1 + DCR flow
 * against an MCP server. Throws DiscoveryError with a user-readable message
 * when the server cannot support this tool.
 */
export async function discoverProviderMetadata(
  serverUrl: string,
  fetchImpl: FetchLike = fetch,
): Promise<DiscoveryResult> {
  const server = new URL(serverUrl);

  // --- 1. RFC 9728 protected-resource metadata -----------------------------
  const resourceCandidates = dedupe([
    `${server.origin}/.well-known/oauth-protected-resource${server.pathname === '/' ? '' : server.pathname}`,
    `${server.origin}/.well-known/oauth-protected-resource`,
  ]);

  let resourceMetadata: Record<string, unknown> | null = null;
  for (const candidate of resourceCandidates) {
    resourceMetadata = await fetchJsonObject(candidate, fetchImpl);
    if (resourceMetadata) break;
  }
  if (!resourceMetadata) {
    const challengeUrl = await probeResourceMetadataUrl(serverUrl, fetchImpl);
    if (challengeUrl) {
      resourceMetadata = await fetchJsonObject(challengeUrl, fetchImpl);
    }
  }
  if (!resourceMetadata) {
    throw new DiscoveryError(
      'Could not discover OAuth metadata for this MCP server. It may not support MCP OAuth (RFC 9728).',
    );
  }

  const resource = cleanString(resourceMetadata.resource);
  const authorizationServers = Array.isArray(resourceMetadata.authorization_servers)
    ? resourceMetadata.authorization_servers
        .map((value) => cleanString(value))
        .filter((value): value is string => Boolean(value))
    : [];
  const scopesSupported = Array.isArray(resourceMetadata.scopes_supported)
    ? resourceMetadata.scopes_supported
        .map((value) => cleanString(value))
        .filter((value): value is string => Boolean(value))
    : [];

  // --- 2. Authorization server metadata ------------------------------------
  const asCandidates = authorizationServers.length > 0 ? authorizationServers : [server.origin];
  let asMetadata: Record<string, unknown> | null = null;

  for (const candidate of asCandidates) {
    let asUrl: URL;
    try {
      asUrl = new URL(candidate);
    } catch {
      continue;
    }
    const metadataUrls = dedupe([
      `${asUrl.origin}/.well-known/oauth-authorization-server${asUrl.pathname === '/' ? '' : asUrl.pathname}`,
      `${asUrl.origin}/.well-known/oauth-authorization-server`,
      `${asUrl.origin}/.well-known/openid-configuration${asUrl.pathname === '/' ? '' : asUrl.pathname}`,
      `${asUrl.origin}/.well-known/openid-configuration`,
    ]);
    for (const metadataUrl of metadataUrls) {
      asMetadata = await fetchJsonObject(metadataUrl, fetchImpl);
      if (asMetadata && cleanString(asMetadata.token_endpoint)) break;
      asMetadata = null;
    }
    if (asMetadata) break;
  }

  if (!asMetadata) {
    throw new DiscoveryError('Could not discover the OAuth authorization server metadata for this MCP server.');
  }

  // --- 3. Validate for browser public-client use ---------------------------
  const authorizationEndpoint = requireEndpoint(asMetadata, 'authorization_endpoint', 'an authorization endpoint');
  const tokenEndpoint = requireEndpoint(asMetadata, 'token_endpoint', 'a token endpoint');
  const registrationEndpoint = requireEndpoint(
    asMetadata,
    'registration_endpoint',
    'a Dynamic Client Registration endpoint',
  );
  const revocationEndpoint = cleanString(asMetadata.revocation_endpoint);
  const issuer = cleanString(asMetadata.issuer);

  const pkceMethods = Array.isArray(asMetadata.code_challenge_methods_supported)
    ? asMetadata.code_challenge_methods_supported.map(String)
    : [];
  if (!pkceMethods.includes('S256')) {
    throw new DiscoveryError('This MCP server does not support PKCE (S256), which is required for browser clients.');
  }

  const authMethods = Array.isArray(asMetadata.token_endpoint_auth_methods_supported)
    ? asMetadata.token_endpoint_auth_methods_supported.map(String)
    : [];
  if (authMethods.length > 0 && !authMethods.includes('none')) {
    throw new DiscoveryError(
      'This MCP server requires a confidential OAuth client (client secret). Browser tools can only use public clients.',
    );
  }

  assertSameOrigin(authorizationEndpoint, server.origin, 'authorization endpoint');
  assertSameOrigin(tokenEndpoint, server.origin, 'token endpoint');
  assertSameOrigin(registrationEndpoint, server.origin, 'registration endpoint');
  if (revocationEndpoint) assertSameOrigin(revocationEndpoint, server.origin, 'revocation endpoint');

  return {
    serverUrl,
    resource,
    issuer,
    authorizationEndpoint,
    tokenEndpoint,
    registrationEndpoint,
    revocationEndpoint,
    scopesSupported,
  };
}
