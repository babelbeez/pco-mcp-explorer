// Deployment-level constants for the explorer app.

/** Canonical PCO MCP server URL (only upstream host the proxy is allowed to reach). */
export const PCO_SERVER_URL = 'https://mcp.planningcenteronline.com/mcp';

/** OAuth client metadata used during Dynamic Client Registration. */
export const CLIENT_NAME = 'PCO MCP Explorer';
export const CLIENT_HOMEPAGE = 'https://github.com/babelbeez/pco-mcp-explorer';

/** MCP protocol version used for initialize (matches known-good PCO behavior). */
export const MCP_PROTOCOL_VERSION = '2025-03-26';

export const CLIENT_INFO = { name: 'pco-mcp-explorer', version: '1.0.0' } as const;

/**
 * Base URL of the companion CORS proxy worker (see worker/).
 * Configured at build time via the VITE_PROXY_BASE_URL environment variable,
 * e.g. https://pco-mcp-explorer-proxy.<your-subdomain>.workers.dev
 */
export const PROXY_BASE_URL: string = (import.meta.env.VITE_PROXY_BASE_URL ?? '').replace(/\/+$/, '');

export function isProxyConfigured(): boolean {
  return PROXY_BASE_URL.length > 0;
}

/** OAuth redirect URI for this deployment (the app root). */
export function redirectUri(): string {
  return `${window.location.origin}${import.meta.env.BASE_URL}`;
}

/**
 * Rewrites a PCO-host URL through the CORS proxy. Refuses to proxy any URL that
 * is not on the PCO MCP origin so tokens can never leak to a third-party host.
 */
export function proxiedUrl(upstreamUrl: string): string {
  const upstream = new URL(upstreamUrl);
  const server = new URL(PCO_SERVER_URL);
  if (upstream.origin !== server.origin) {
    throw new Error(`Refusing to proxy URL on unexpected host: ${upstream.origin}`);
  }
  return `${PROXY_BASE_URL}${upstream.pathname}${upstream.search}`;
}

/** fetch() wrapper that transparently routes PCO-host URLs through the proxy. */
export function proxiedFetch(input: string, init?: RequestInit): Promise<Response> {
  return fetch(proxiedUrl(input), init);
}
