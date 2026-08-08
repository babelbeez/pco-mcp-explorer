// PCO MCP Explorer — CORS proxy worker.
//
// Why this exists: mcp.planningcenteronline.com sends no CORS headers, so a
// browser app hosted on GitHub Pages cannot read its responses. This worker
// forwards a small allowlist of PCO OAuth/MCP endpoints and attaches CORS
// headers for the allowed page origins only.
//
// Security posture:
// - Fixed upstream host; only GET/POST on an explicit path allowlist.
// - Forwards only the headers the flow needs (Authorization passes through
//   untouched; cookies and other browser headers are never forwarded).
// - No logging of request bodies, headers, or tokens. Nothing is stored.

const UPSTREAM_ORIGIN = 'https://mcp.planningcenteronline.com';

const EXACT_PATHS = new Set(['/mcp', '/register', '/token', '/revoke']);
const ALLOWED_PREFIXES = ['/.well-known/'];
const ALLOWED_METHODS = new Set(['GET', 'POST']);

const REQUEST_HEADER_ALLOWLIST = [
  'content-type',
  'accept',
  'authorization',
  'mcp-session-id',
  'mcp-protocol-version',
];

const RESPONSE_HEADER_ALLOWLIST = ['content-type', 'mcp-session-id', 'retry-after', 'www-authenticate'];

const PREFLIGHT_HEADERS = 'content-type, authorization, mcp-session-id, mcp-protocol-version';

export interface Env {
  /** Comma-separated list of origins allowed to use this proxy. */
  ALLOWED_ORIGINS?: string;
}

function allowedOriginFor(request: Request, env: Env): string | null {
  const origin = request.headers.get('Origin');
  if (!origin) return null;
  const allowed = (env.ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  return allowed.includes(origin) ? origin : null;
}

function corsHeaders(origin: string | null): Headers {
  const headers = new Headers();
  if (origin) {
    headers.set('Access-Control-Allow-Origin', origin);
    headers.set('Access-Control-Expose-Headers', 'mcp-session-id');
    headers.set('Vary', 'Origin');
  }
  headers.set('Cache-Control', 'no-store');
  return headers;
}

function jsonResponse(status: number, error: string, origin: string | null): Response {
  const headers = corsHeaders(origin);
  headers.set('Content-Type', 'application/json');
  return new Response(JSON.stringify({ error }), { status, headers });
}

function handlePreflight(origin: string | null): Response {
  if (!origin) {
    return new Response(null, { status: 403 });
  }
  const headers = corsHeaders(origin);
  headers.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  headers.set('Access-Control-Allow-Headers', PREFLIGHT_HEADERS);
  headers.set('Access-Control-Max-Age', '86400');
  return new Response(null, { status: 204, headers });
}

function isPathAllowed(pathname: string): boolean {
  return EXACT_PATHS.has(pathname) || ALLOWED_PREFIXES.some((prefix) => pathname.startsWith(prefix));
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const origin = allowedOriginFor(request, env);
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return handlePreflight(origin);
    }

    // Health check — no upstream call, no data.
    if (url.pathname === '/' && request.method === 'GET') {
      return jsonResponse(200, 'ok', origin);
    }

    if (!ALLOWED_METHODS.has(request.method)) {
      return jsonResponse(405, 'method_not_allowed', origin);
    }

    if (!isPathAllowed(url.pathname)) {
      return jsonResponse(403, 'path_not_allowed', origin);
    }

    const headers = new Headers();
    for (const name of REQUEST_HEADER_ALLOWLIST) {
      const value = request.headers.get(name);
      if (value) headers.set(name, value);
    }
    headers.set('user-agent', 'pco-mcp-explorer-proxy/1.0');

    let upstream: Response;
    try {
      upstream = await fetch(`${UPSTREAM_ORIGIN}${url.pathname}${url.search}`, {
        method: request.method,
        headers,
        body: request.method === 'GET' ? undefined : request.body,
        redirect: 'manual',
      });
    } catch {
      return jsonResponse(502, 'upstream_unreachable', origin);
    }

    const responseHeaders = corsHeaders(origin);
    for (const name of RESPONSE_HEADER_ALLOWLIST) {
      const value = upstream.headers.get(name);
      if (value) responseHeaders.set(name, value);
    }

    return new Response(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: responseHeaders,
    });
  },
} satisfies ExportedHandler<Env>;
