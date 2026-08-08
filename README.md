# 🐝 PCO MCP Explorer

**Explore the [Planning Center Online](https://www.planningcenter.com/) MCP server tool manifest in your browser.**

Planning Center's new [MCP server](https://help.planningcenter.com/en/151880-connect-ai-tools-to-planning-center.html) (`https://mcp.planningcenteronline.com/mcp`) lets AI tools work with your PCO data — but its tool surface currently isn't documented anywhere. This free tool signs you in with OAuth and shows you the live manifest: every tool, its parameters, behavior annotations, and the raw JSON.

**Live tool → https://babelbeez.github.io/pco-mcp-explorer/**

## What it does

1. **Discovers** the server's OAuth configuration (RFC 9728 protected-resource metadata → RFC 8414 authorization server metadata).
2. **Registers itself** as a public OAuth client via RFC 7591 Dynamic Client Registration — no pre-shared secrets, nothing to configure.
3. **Redirects you to Planning Center's own sign-in**, where you pick exactly which scopes to grant (authorization code + PKCE S256, with the RFC 8707 resource indicator).
4. **Fetches the live tool manifest** (`initialize` → `tools/list`, paginated) and renders it as a searchable, readable table — humanized tool names, cleaned descriptions, parameter tables, and read-only/destructive badges — with the raw JSON one click away, plus a one-click **Export JSON** of the whole manifest.
5. **Disconnect** revokes your token (RFC 7009) and wipes it from the browser.

## Security & privacy

- **Everything runs in your browser.** There is no backend database, no analytics, no cookies.
- Your access token lives only in the tab's `sessionStorage` and is discarded when you disconnect or close the tab.
- The OAuth client is a **public client** (PCO only issues `token_endpoint_auth_method: "none"` registrations), so there is no client secret anywhere in the chain.
- The only state persisted across visits is the DCR `client_id` in `localStorage` (not a credential).
- You choose the scopes on Planning Center's consent screen — the tool deliberately sends no `scope` parameter of its own.

### The CORS proxy (`worker/`)

PCO's server currently sends **no CORS headers**, so a purely client-side app on GitHub Pages cannot read its API responses. Until that changes, all API calls go through a tiny (~120 LoC) Cloudflare Worker that:

- only forwards `GET`/`POST` to an **explicit allowlist of paths** on `mcp.planningcenteronline.com`,
- only answers the configured page origins,
- forwards your `Authorization` header untouched and **stores/logs nothing**.

If PCO ever adds CORS headers, the proxy can simply be deleted — the app code already speaks to PCO directly; only the URL rewrite in `src/config.ts` would change.

## Repository layout

```
├── index.html / src/         The static SPA (Vite + TypeScript + Tailwind, no UI framework)
│   └── src/lib/              discovery · dcr · oauth (PKCE) · mcp (JSON-RPC/SSE) · manifest parsing
├── worker/                   Cloudflare Worker CORS proxy (see above)
├── scripts/verify-live.mjs   Live contract check against the real PCO server
├── tests/                    Vitest unit tests (parsing, SSE, discovery, OAuth URL)
└── .github/workflows/        GitHub Pages deploy + worker deploy
```

## Developing

```bash
npm install
npm run dev          # http://localhost:5173/pco-mcp-explorer/
npm test             # unit tests
npm run build        # typecheck + production build to dist/
npm run verify:live  # live contract check against the real PCO MCP server
```

For local development the app calls the deployed proxy by default. Set `VITE_PROXY_BASE_URL` in a `.env.local` file to override (e.g. point it at `http://localhost:8787` while running `npm run dev --prefix worker` for the worker locally). The OAuth redirect URI always matches the current origin, and DCR registers whatever redirect URI is in use, so `localhost` works out of the box.

## Deploying your own copy

1. **Fork/clone** this repo.
2. **Deploy the worker** (Cloudflare, free tier):
   - Add repository secrets `CF_API_TOKEN` and `CF_ACCOUNT_ID`, then run the *Deploy CORS proxy worker* workflow — or run `npm install --prefix worker && npm run deploy --prefix worker` locally.
   - Update `ALLOWED_ORIGINS` in `worker/wrangler.toml` to your Pages origin.
3. **Point the app at your worker**: add a repository *variable* `PROXY_BASE_URL` (Settings → Secrets and variables → Actions → Variables) with your worker URL, e.g. `https://pco-mcp-explorer-proxy.<subdomain>.workers.dev`.
4. **Enable GitHub Pages**: Settings → Pages → Source: *GitHub Actions*. The *Deploy site to GitHub Pages* workflow builds and publishes on every push to `main`.

## FAQ

**Does this modify my Planning Center data?**
No — it only ever calls `tools/list`. It never invokes a tool. Grant read-only scopes on the consent screen if you prefer.

**Why do I have to sign in at all?**
The PCO MCP server requires OAuth for every request — the manifest can differ per granted scopes, so it can only be fetched with a token.

**Is this affiliated with Planning Center?**
No. It's an independent open-source project built by [Babelbeez](https://www.babelbeez.com) (voice AI agents for websites — which itself connects to Planning Center via MCP).

## License

[MIT](LICENSE) © Babelbeez
