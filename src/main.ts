import './style.css';

import {
  PCO_SERVER_URL,
  isProxyConfigured,
  proxiedFetch,
  redirectUri,
} from './config';
import { discoverProviderMetadata, type DiscoveryResult } from './lib/discovery';
import { listTools, McpAuthError, type McpTool } from './lib/mcp';
import {
  completeAuthorizationFlow,
  parseCallback,
  prepareAuthorizationRedirect,
  revokeSession,
} from './lib/oauth';
import {
  clearSession,
  isSessionExpired,
  loadSession,
  type StoredSession,
} from './lib/storage';
import { buildToolRows, filterToolRows, type ToolRow } from './lib/manifest';

// ---------------------------------------------------------------------------
// DOM helpers
// ---------------------------------------------------------------------------

function mustGet<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing required element #${id}`);
  return element as T;
}

const sections = {
  connect: mustGet<HTMLElement>('connect-section'),
  working: mustGet<HTMLElement>('working-section'),
  manifest: mustGet<HTMLElement>('manifest-section'),
};

const ui = {
  proxyWarning: mustGet<HTMLDivElement>('proxy-warning'),
  statusBanner: mustGet<HTMLDivElement>('status-banner'),
  workingMessage: mustGet<HTMLParagraphElement>('working-message'),
  connectButton: mustGet<HTMLButtonElement>('connect-button'),
  disconnectButton: mustGet<HTMLButtonElement>('disconnect-button'),
  exportButton: mustGet<HTMLButtonElement>('export-button'),
  toolsSearch: mustGet<HTMLInputElement>('tools-search'),
  toolsCount: mustGet<HTMLParagraphElement>('tools-count'),
  scopesList: mustGet<HTMLDivElement>('scopes-list'),
  toolsContainer: mustGet<HTMLDivElement>('tools-container'),
  emptyTools: mustGet<HTMLParagraphElement>('empty-tools'),
  noResults: mustGet<HTMLParagraphElement>('no-results'),
};

type View = 'connect' | 'working' | 'manifest';

function showView(view: View): void {
  sections.connect.classList.toggle('hidden', view !== 'connect');
  sections.working.classList.toggle('hidden', view !== 'working');
  sections.manifest.classList.toggle('hidden', view !== 'manifest');
}

function showBanner(kind: 'error' | 'info', message: string): void {
  ui.statusBanner.textContent = message;
  ui.statusBanner.classList.remove('hidden', 'border-red-300', 'bg-red-50', 'text-red-800', 'border-blue-300', 'bg-blue-50', 'text-blue-800');
  if (kind === 'error') {
    ui.statusBanner.classList.add('border-red-300', 'bg-red-50', 'text-red-800');
  } else {
    ui.statusBanner.classList.add('border-blue-300', 'bg-blue-50', 'text-blue-800');
  }
}

function hideBanner(): void {
  ui.statusBanner.classList.add('hidden');
  ui.statusBanner.textContent = '';
}

function setWorking(message: string): void {
  ui.workingMessage.textContent = message;
  showView('working');
}

function errorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message) return error.message;
  return fallback;
}

// ---------------------------------------------------------------------------
// Manifest rendering (DOM-built with textContent — remote data is never
// injected as HTML)
// ---------------------------------------------------------------------------

let currentRows: ToolRow[] = [];
let currentTools: McpTool[] = [];
let currentSession: StoredSession | null = null;
let currentDiscovery: DiscoveryResult | null = null;

function appendBadge(parent: HTMLElement, label: string, className: string): void {
  const badge = document.createElement('span');
  badge.className = className;
  badge.textContent = label;
  parent.appendChild(badge);
}

function buildToolRow(row: ToolRow): HTMLElement {
  const card = document.createElement('div');
  card.className = 'card overflow-hidden';

  const header = document.createElement('button');
  header.type = 'button';
  header.className = 'flex w-full flex-col gap-2 px-5 py-4 text-left transition-colors hover:bg-gray-50';
  header.setAttribute('aria-expanded', 'false');

  const topLine = document.createElement('div');
  topLine.className = 'flex items-start justify-between gap-3';

  const titleWrap = document.createElement('div');
  titleWrap.className = 'flex min-w-0 flex-col gap-0.5';

  const title = document.createElement('span');
  title.className = 'font-semibold text-brand-heading break-words';
  title.textContent = row.displayTitle;

  const toolId = document.createElement('span');
  toolId.className = 'font-mono text-xs text-gray-500 break-all';
  toolId.textContent = `Tool ID: ${row.name}`;

  titleWrap.append(title, toolId);

  const chevron = document.createElement('span');
  chevron.className = 'mt-1 shrink-0 text-gray-400 transition-transform';
  chevron.setAttribute('aria-hidden', 'true');
  chevron.textContent = '▾';

  topLine.append(titleWrap, chevron);

  const summary = document.createElement('p');
  summary.className = 'text-sm leading-relaxed';
  summary.textContent = row.summary;

  header.append(topLine, summary);

  if (row.behaviorBadges.length > 0) {
    const badges = document.createElement('div');
    badges.className = 'flex flex-wrap gap-1.5';
    for (const badge of row.behaviorBadges) {
      appendBadge(badges, badge.label, badge.className);
    }
    header.appendChild(badges);
  }

  if (row.parameters.length > 0) {
    const preview = document.createElement('div');
    preview.className = 'flex flex-col gap-0.5';
    for (const parameter of row.parameters.slice(0, 3)) {
      const line = document.createElement('span');
      line.className = 'text-xs text-gray-500';
      line.textContent = `${parameter.name} · ${parameter.type}${parameter.required ? ' · required' : ''} — ${parameter.description}`;
      preview.appendChild(line);
    }
    if (row.parameters.length > 3) {
      const more = document.createElement('span');
      more.className = 'text-xs text-gray-400';
      const count = row.parameters.length - 3;
      more.textContent = `+${count} more parameter${count === 1 ? '' : 's'}`;
      preview.appendChild(more);
    }
    header.appendChild(preview);
  }

  // Expanded detail panel -------------------------------------------------
  const detail = document.createElement('div');
  detail.className = 'hidden border-t border-gray-200 bg-gray-50 px-5 py-4';

  const detailWrap = document.createElement('div');
  detailWrap.className = 'flex flex-col gap-4';

  if (row.fullDescription && row.fullDescription !== row.summary) {
    const full = document.createElement('div');
    const fullLabel = document.createElement('p');
    fullLabel.className = 'text-xs font-semibold uppercase tracking-wide text-gray-500';
    fullLabel.textContent = 'Full description';
    const fullText = document.createElement('p');
    fullText.className = 'mt-1 whitespace-pre-wrap text-sm leading-relaxed';
    fullText.textContent = row.fullDescription;
    full.append(fullLabel, fullText);
    detailWrap.appendChild(full);
  }

  if (row.parameters.length > 0) {
    const params = document.createElement('div');
    const paramsLabel = document.createElement('p');
    paramsLabel.className = 'text-xs font-semibold uppercase tracking-wide text-gray-500';
    paramsLabel.textContent = `Parameters (${row.parameters.length})`;
    params.appendChild(paramsLabel);

    const list = document.createElement('div');
    list.className = 'mt-2 flex flex-col gap-2';
    for (const parameter of row.parameters) {
      const item = document.createElement('div');
      item.className = 'rounded-lg border border-gray-200 bg-white px-3 py-2';

      const nameLine = document.createElement('p');
      nameLine.className = 'text-sm';
      const nameStrong = document.createElement('span');
      nameStrong.className = 'font-mono font-medium text-brand-heading';
      nameStrong.textContent = parameter.name;
      const meta = document.createElement('span');
      meta.className = 'ml-2 text-xs text-gray-500';
      meta.textContent = `${parameter.type}${parameter.required ? ' · required' : ''}`;
      nameLine.append(nameStrong, meta);

      const description = document.createElement('p');
      description.className = 'mt-0.5 text-xs leading-relaxed text-gray-600';
      description.textContent = parameter.description;

      item.append(nameLine, description);
      list.appendChild(item);
    }
    params.appendChild(list);
    detailWrap.appendChild(params);
  }

  const rawDetails = document.createElement('details');
  rawDetails.className = 'text-sm';
  const rawSummary = document.createElement('summary');
  rawSummary.className = 'cursor-pointer text-xs font-semibold uppercase tracking-wide text-gray-500 hover:text-brand-primary';
  rawSummary.textContent = 'Raw manifest JSON';
  const rawPre = document.createElement('pre');
  rawPre.className = 'mt-2 max-h-96 overflow-auto rounded-lg bg-gray-900 p-3 text-xs leading-relaxed text-gray-100';
  rawPre.textContent = JSON.stringify(row.raw, null, 2);
  rawDetails.append(rawSummary, rawPre);
  detailWrap.appendChild(rawDetails);

  detail.appendChild(detailWrap);

  header.addEventListener('click', () => {
    const expanded = header.getAttribute('aria-expanded') === 'true';
    header.setAttribute('aria-expanded', String(!expanded));
    detail.classList.toggle('hidden', expanded);
    chevron.classList.toggle('rotate-180', !expanded);
  });

  card.append(header, detail);
  return card;
}

function renderTools(): void {
  const query = ui.toolsSearch.value;
  const rows = filterToolRows(currentRows, query);

  ui.toolsContainer.replaceChildren(...rows.map(buildToolRow));
  ui.emptyTools.classList.toggle('hidden', currentRows.length !== 0);
  ui.noResults.classList.toggle('hidden', currentRows.length === 0 || rows.length !== 0);

  const total = currentRows.length;
  ui.toolsCount.textContent = query
    ? `${rows.length} of ${total} tools match “${query}”`
    : `${total} tool${total === 1 ? '' : 's'} available`;
}

function renderScopes(session: StoredSession): void {
  ui.scopesList.replaceChildren();
  const scopes = (session.scope ?? '').split(' ').map((scope) => scope.trim()).filter(Boolean);
  if (scopes.length === 0) return;

  const label = document.createElement('span');
  label.className = 'text-xs font-medium text-gray-500';
  label.textContent = 'Granted scopes:';
  ui.scopesList.appendChild(label);

  for (const scope of scopes) {
    appendBadge(ui.scopesList, scope, 'badge-scope');
  }
}

// ---------------------------------------------------------------------------
// Flows
// ---------------------------------------------------------------------------

async function discover(): Promise<DiscoveryResult> {
  if (!currentDiscovery) {
    currentDiscovery = await discoverProviderMetadata(PCO_SERVER_URL, proxiedFetch);
  }
  return currentDiscovery;
}

async function startConnect(): Promise<void> {
  hideBanner();
  ui.connectButton.disabled = true;
  try {
    setWorking('Contacting Planning Center…');
    const discovery = await discover();
    const authorizationUrl = await prepareAuthorizationRedirect(discovery, redirectUri(), proxiedFetch);
    setWorking('Redirecting you to Planning Center to sign in…');
    window.location.assign(authorizationUrl);
  } catch (error) {
    showView('connect');
    showBanner('error', errorMessage(error, 'Could not start the sign-in flow. Please try again.'));
    ui.connectButton.disabled = false;
  }
}

async function loadManifest(session: StoredSession): Promise<void> {
  setWorking('Fetching the live tool manifest…');
  try {
    const tools = await listTools(PCO_SERVER_URL, session.accessToken, proxiedFetch);
    currentTools = tools;
    currentRows = buildToolRows(tools);
    currentSession = session;
    renderScopes(session);
    renderTools();
    showView('manifest');
  } catch (error) {
    if (error instanceof McpAuthError) {
      clearSession();
      currentSession = null;
      showView('connect');
      ui.connectButton.disabled = false;
      showBanner('info', error.message);
      return;
    }
    showView('connect');
    ui.connectButton.disabled = false;
    showBanner('error', errorMessage(error, 'Could not load the tool manifest. Please try again.'));
  }
}

async function handleOAuthCallback(code: string, state: string): Promise<void> {
  setWorking('Completing sign-in…');
  try {
    const discovery = await discover();
    const session = await completeAuthorizationFlow(discovery, code, state, redirectUri(), proxiedFetch);
    window.history.replaceState(null, '', window.location.pathname);
    await loadManifest(session);
  } catch (error) {
    window.history.replaceState(null, '', window.location.pathname);
    showView('connect');
    ui.connectButton.disabled = false;
    showBanner('error', errorMessage(error, 'Sign-in could not be completed. Please try again.'));
  }
}

async function disconnect(): Promise<void> {
  hideBanner();
  const session = currentSession;
  currentSession = null;
  currentRows = [];
  currentTools = [];
  ui.toolsSearch.value = '';
  clearSession();

  if (session) {
    try {
      const discovery = await discover();
      await revokeSession(discovery, session, proxiedFetch);
    } catch {
      // Revocation is best-effort; local state is already cleared.
    }
  }

  showView('connect');
  ui.connectButton.disabled = false;
  showBanner('info', 'Disconnected. Your access token was revoked and removed from this browser.');
}

function exportManifest(): void {
  if (currentTools.length === 0) return;
  const blob = new Blob([JSON.stringify({ tools: currentTools }, null, 2)], {
    type: 'application/json',
  });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = 'pco-mcp-tool-manifest.json';
  anchor.click();
  URL.revokeObjectURL(url);
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

async function boot(): Promise<void> {
  ui.connectButton.addEventListener('click', () => void startConnect());
  ui.disconnectButton.addEventListener('click', () => void disconnect());
  ui.exportButton.addEventListener('click', exportManifest);
  ui.toolsSearch.addEventListener('input', renderTools);

  if (!isProxyConfigured()) {
    ui.proxyWarning.classList.remove('hidden');
    ui.connectButton.disabled = true;
  }

  const callback = parseCallback(window.location.search);
  if (callback?.kind === 'error') {
    window.history.replaceState(null, '', window.location.pathname);
    showView('connect');
    showBanner(
      callback.error === 'access_denied' ? 'info' : 'error',
      callback.error === 'access_denied'
        ? 'You declined the authorization request in Planning Center. Nothing was connected.'
        : `Planning Center returned an error during sign-in (${callback.error}). Please try again.`,
    );
    return;
  }
  if (callback?.kind === 'code') {
    if (!isProxyConfigured()) return;
    await handleOAuthCallback(callback.code, callback.state);
    return;
  }

  const session = loadSession();
  if (session && !isSessionExpired(session)) {
    if (!isProxyConfigured()) return;
    await loadManifest(session);
    return;
  }
  if (session) {
    clearSession();
    showBanner('info', 'Your previous session expired. Please connect again.');
  }

  showView('connect');
}

void boot();
