// Minimal MCP JSON-RPC client for fetching the tool manifest.
//   initialize → notifications/initialized (best effort) → tools/list (paginated)
// Responses may be plain JSON or SSE (text/event-stream); both are handled.

import { CLIENT_INFO, MCP_PROTOCOL_VERSION } from '../config';
import { cleanString, isRecord, type FetchLike } from './util';

export class McpError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'McpError';
  }
}

/** Thrown when the MCP server rejects the access token. */
export class McpAuthError extends McpError {
  constructor(message = 'Your Planning Center session expired. Please connect again.') {
    super(message);
    this.name = 'McpAuthError';
  }
}

export interface McpTool {
  name: string;
  title?: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  annotations?: Record<string, unknown>;
}

/**
 * Parses a JSON-RPC payload from a response body that may be plain JSON or
 * SSE-framed (`data: {...}` lines). Returns the first parseable JSON object.
 */
export function extractJsonRpcPayload(text: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(text);
    if (isRecord(parsed)) return parsed;
  } catch {
    // Not plain JSON — try SSE framing below.
  }

  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith('data:')) continue;
    const data = line.slice('data:'.length).trim();
    if (!data || data === '[DONE]') continue;
    try {
      const parsed: unknown = JSON.parse(data);
      if (isRecord(parsed)) return parsed;
    } catch {
      continue;
    }
  }
  return null;
}

interface JsonRpcResult {
  payload: Record<string, unknown> | null;
  sessionId: string | null;
}

async function postJsonRpc(
  serverUrl: string,
  accessToken: string,
  method: string,
  params: Record<string, unknown> | undefined,
  sessionId: string | null,
  fetchImpl: FetchLike,
  notification = false,
): Promise<JsonRpcResult> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${accessToken}`,
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
    'MCP-Protocol-Version': MCP_PROTOCOL_VERSION,
  };
  if (sessionId) {
    headers['Mcp-Session-Id'] = sessionId;
  }

  let response: Response;
  try {
    response = await fetchImpl(serverUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        jsonrpc: '2.0',
        ...(notification ? {} : { id: crypto.randomUUID() }),
        method,
        ...(params ? { params } : {}),
      }),
    });
  } catch {
    throw new McpError('Could not reach the Planning Center MCP server. Check your connection and try again.');
  }

  if (response.status === 401 || response.status === 403) {
    throw new McpAuthError();
  }
  if (!response.ok) {
    throw new McpError(`The MCP server returned HTTP ${response.status} for ${method}.`);
  }

  const returnedSessionId = cleanString(response.headers.get('mcp-session-id')) ?? sessionId;
  const text = await response.text();
  return { payload: extractJsonRpcPayload(text), sessionId: returnedSessionId };
}

function normalizeTool(raw: unknown): McpTool | null {
  if (!isRecord(raw)) return null;
  const name = cleanString(raw.name);
  if (!name) return null;
  return {
    name,
    title: cleanString(raw.title) ?? undefined,
    description: typeof raw.description === 'string' ? raw.description : undefined,
    inputSchema: isRecord(raw.inputSchema) ? raw.inputSchema : undefined,
    annotations: isRecord(raw.annotations) ? raw.annotations : undefined,
  };
}

/** Fetches the full tool manifest, following nextCursor pagination (max 10 pages). */
export async function listTools(
  serverUrl: string,
  accessToken: string,
  fetchImpl: FetchLike = fetch,
): Promise<McpTool[]> {
  let sessionId: string | null = null;

  try {
    const init = await postJsonRpc(
      serverUrl,
      accessToken,
      'initialize',
      { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: {}, clientInfo: { ...CLIENT_INFO } },
      null,
      fetchImpl,
    );
    sessionId = init.sessionId;
    // Spec-correct, but tolerated if the server rejects it.
    try {
      await postJsonRpc(serverUrl, accessToken, 'notifications/initialized', undefined, sessionId, fetchImpl, true);
    } catch {
      // ignore — some servers do not require the notification
    }
  } catch (error) {
    if (error instanceof McpAuthError) throw error;
    // Fall through to tools/list without a session, mirroring the backend's
    // defensive behavior for servers that do not support initialize.
  }

  const tools: McpTool[] = [];
  let cursor: string | null = null;

  for (let page = 0; page < 10; page += 1) {
    const { payload } = await postJsonRpc(
      serverUrl,
      accessToken,
      'tools/list',
      cursor ? { cursor } : {},
      sessionId,
      fetchImpl,
    );

    if (!payload) {
      throw new McpError('The MCP server returned an unreadable tools/list response.');
    }
    if (isRecord(payload.error)) {
      const message = cleanString(payload.error.message) ?? 'unknown error';
      throw new McpError(`tools/list failed: ${message}`);
    }

    const result = isRecord(payload.result) ? payload.result : {};
    const rawTools = Array.isArray(result.tools) ? result.tools : [];
    for (const raw of rawTools) {
      const tool = normalizeTool(raw);
      if (tool) tools.push(tool);
    }

    cursor = cleanString(result.nextCursor);
    if (!cursor) break;
  }

  return tools;
}
