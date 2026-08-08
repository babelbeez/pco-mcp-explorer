#!/usr/bin/env node
// Live contract check against the real Planning Center MCP server.
//
// Verifies everything the browser app depends on, short of the interactive
// login (Node is not subject to CORS, so this talks to PCO directly):
//   1. RFC 9728 protected-resource metadata
//   2. Authorization server metadata (PKCE S256 + public-client support)
//   3. Dynamic Client Registration (registers a throwaway public client)
//   4. The authorization endpoint renders an interactive page for that client
//   5. The MCP endpoint itself requires a bearer token
//
// Usage: npm run verify:live

const SERVER_URL = 'https://mcp.planningcenteronline.com/mcp';
const ORIGIN = new URL(SERVER_URL).origin;

let failures = 0;

function check(label, condition, detail = '') {
  const status = condition ? 'PASS' : 'FAIL';
  if (!condition) failures += 1;
  console.log(`${status === 'PASS' ? '✅' : '❌'} ${label}${detail ? ` — ${detail}` : ''}`);
}

async function getJson(url) {
  const response = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!response.ok) throw new Error(`GET ${url} → HTTP ${response.status}`);
  return response.json();
}

console.log(`\nVerifying PCO MCP server contract at ${SERVER_URL}\n`);

// 1. Protected resource metadata ------------------------------------------
const protectedResource = await getJson(`${ORIGIN}/.well-known/oauth-protected-resource`);
check('RFC 9728 protected-resource metadata', protectedResource.resource === SERVER_URL, protectedResource.resource);
check(
  'authorization_servers advertised',
  Array.isArray(protectedResource.authorization_servers) && protectedResource.authorization_servers.length > 0,
  protectedResource.authorization_servers?.join(', '),
);

// 2. Authorization server metadata -----------------------------------------
const authServer = await getJson(`${ORIGIN}/.well-known/oauth-authorization-server`);
check('authorization endpoint', typeof authServer.authorization_endpoint === 'string', authServer.authorization_endpoint);
check('token endpoint', typeof authServer.token_endpoint === 'string', authServer.token_endpoint);
check('registration endpoint (DCR)', typeof authServer.registration_endpoint === 'string', authServer.registration_endpoint);
check('revocation endpoint', typeof authServer.revocation_endpoint === 'string', authServer.revocation_endpoint);
check('PKCE S256 supported', authServer.code_challenge_methods_supported?.includes('S256'));
check(
  'public clients allowed (token_endpoint_auth_method none)',
  authServer.token_endpoint_auth_methods_supported?.includes('none'),
);

// 3. Dynamic Client Registration -------------------------------------------
const redirectUri = 'http://localhost:5173/';
const registrationResponse = await fetch(authServer.registration_endpoint, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
  body: JSON.stringify({
    // Must match the app's DCR client_name policy: PCO blocks brand strings
    // ("PCO", "Planning Center") in client names for non-localhost redirects.
    client_name: 'Babelbeez MCP Explorer (verify-live)',
    client_uri: 'https://github.com/babelbeez/pco-mcp-explorer',
    redirect_uris: [redirectUri],
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
  }),
});
const registration = await registrationResponse.json().catch(() => ({}));
check(
  'dynamic client registration (public client)',
  registrationResponse.status === 201 && typeof registration.client_id === 'string',
  `HTTP ${registrationResponse.status}, client_id ${registration.client_id ?? 'missing'}`,
);
check(
  'no client_secret issued for public clients',
  registration.token_endpoint_auth_method === 'none' && !registration.client_secret,
);

// 4. Authorization endpoint renders an interactive page --------------------
const codeChallenge = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))))
  .replace(/\+/g, '-')
  .replace(/\//g, '_')
  .replace(/=+$/, '');
const authorizeParams = new URLSearchParams({
  response_type: 'code',
  client_id: registration.client_id ?? 'invalid',
  redirect_uri: redirectUri,
  code_challenge: codeChallenge,
  code_challenge_method: 'S256',
  state: 'verify-live',
  resource: protectedResource.resource,
});
const authorizeResponse = await fetch(`${authServer.authorization_endpoint}?${authorizeParams}`, {
  redirect: 'manual',
});
const authorizeLocation = authorizeResponse.headers.get('location') ?? '';
// A valid request is accepted with a redirect to PCO's sign-in/consent UI;
// invalid clients/redirect URIs are rejected with HTTP 400 instead.
const authorizeLooksInteractive =
  (authorizeResponse.status === 302 || authorizeResponse.status === 303) &&
  /\/(oauth\/)?(consent|sign_in|login)/i.test(authorizeLocation);
check(
  'authorization endpoint accepts the request and routes to sign-in/consent',
  authorizeLooksInteractive,
  `HTTP ${authorizeResponse.status} → ${authorizeLocation || '(no location)'}`,
);

// 5. MCP endpoint requires auth ---------------------------------------------
const mcpResponse = await fetch(SERVER_URL, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
  body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
});
check(
  'MCP endpoint rejects unauthenticated requests with a Bearer challenge',
  mcpResponse.status === 401 && (mcpResponse.headers.get('www-authenticate') ?? '').includes('Bearer'),
  `HTTP ${mcpResponse.status}`,
);

console.log(failures === 0 ? '\nAll checks passed. 🎉\n' : `\n${failures} check(s) failed.\n`);
process.exit(failures === 0 ? 0 : 1);
