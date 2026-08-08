import { describe, expect, it } from 'vitest';

import { extractJsonRpcPayload, listTools, McpAuthError } from '../src/lib/mcp';
import type { FetchLike } from '../src/lib/util';

describe('extractJsonRpcPayload', () => {
  it('parses plain JSON bodies', () => {
    expect(extractJsonRpcPayload('{"jsonrpc":"2.0","id":1,"result":{}}')).toEqual({
      jsonrpc: '2.0',
      id: 1,
      result: {},
    });
  });

  it('parses SSE-framed bodies', () => {
    const body = 'event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{"tools":[]}}\n\n';
    expect(extractJsonRpcPayload(body)).toEqual({
      jsonrpc: '2.0',
      id: 1,
      result: { tools: [] },
    });
  });

  it('skips non-JSON SSE lines and [DONE] sentinels', () => {
    const body = 'data: not-json\ndata: [DONE]\ndata: {"ok":true}\n';
    expect(extractJsonRpcPayload(body)).toEqual({ ok: true });
  });

  it('returns null for unreadable bodies', () => {
    expect(extractJsonRpcPayload('')).toBeNull();
    expect(extractJsonRpcPayload('plain text')).toBeNull();
    expect(extractJsonRpcPayload('[1,2,3]')).toBeNull();
  });
});

describe('listTools', () => {
  const SERVER = 'https://mcp.example.com/mcp';

  function jsonRpcResponse(id: unknown, result: unknown, headers: Record<string, string> = {}): Response {
    return new Response(JSON.stringify({ jsonrpc: '2.0', id, result }), {
      status: 200,
      headers: { 'content-type': 'application/json', ...headers },
    });
  }

  it('initializes, propagates the session id, and follows pagination', async () => {
    const seen: Array<{ method: string; sessionId: string | null; params: unknown }> = [];

    const fetchImpl: FetchLike = async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as {
        id?: unknown;
        method: string;
        params?: Record<string, unknown>;
      };
      const sessionId = (init?.headers as Record<string, string>)['Mcp-Session-Id'] ?? null;
      seen.push({ method: body.method, sessionId, params: body.params ?? null });

      if (body.method === 'initialize') {
        return jsonRpcResponse(body.id, { protocolVersion: '2025-03-26' }, { 'mcp-session-id': 'sess-123' });
      }
      if (body.method === 'notifications/initialized') {
        return new Response('', { status: 202 });
      }
      if (body.method === 'tools/list' && !body.params?.cursor) {
        return jsonRpcResponse(body.id, { tools: [{ name: 'get_people' }], nextCursor: 'page-2' });
      }
      if (body.method === 'tools/list' && body.params?.cursor === 'page-2') {
        return jsonRpcResponse(body.id, { tools: [{ name: 'get_services' }] });
      }
      throw new Error(`unexpected call: ${body.method}`);
    };

    const tools = await listTools(SERVER, 'token-abc', fetchImpl);

    expect(tools.map((tool) => tool.name)).toEqual(['get_people', 'get_services']);
    expect(seen[0].method).toBe('initialize');
    expect(seen[1]).toEqual({ method: 'notifications/initialized', sessionId: 'sess-123', params: null });
    expect(seen[2]).toEqual({ method: 'tools/list', sessionId: 'sess-123', params: {} });
    expect(seen[3]).toEqual({ method: 'tools/list', sessionId: 'sess-123', params: { cursor: 'page-2' } });
  });

  it('parses SSE responses', async () => {
    const fetchImpl: FetchLike = async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as { id?: unknown; method: string };
      if (body.method === 'tools/list') {
        const payload = JSON.stringify({
          jsonrpc: '2.0',
          id: body.id,
          result: { tools: [{ name: 'sse_tool', annotations: { readOnlyHint: true } }] },
        });
        return new Response(`event: message\ndata: ${payload}\n\n`, {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        });
      }
      return jsonRpcResponse(body.id ?? null, {});
    };

    const tools = await listTools(SERVER, 'token-abc', fetchImpl);
    expect(tools).toEqual([{ name: 'sse_tool', annotations: { readOnlyHint: true } }]);
  });

  it('still lists tools when initialize fails (defensive fallback)', async () => {
    const fetchImpl: FetchLike = async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as { id?: unknown; method: string };
      if (body.method === 'initialize') {
        return new Response('boom', { status: 500 });
      }
      if (body.method === 'tools/list') {
        return jsonRpcResponse(body.id, { tools: [{ name: 'fallback_tool' }] });
      }
      return jsonRpcResponse(body.id ?? null, {});
    };

    const tools = await listTools(SERVER, 'token-abc', fetchImpl);
    expect(tools.map((tool) => tool.name)).toEqual(['fallback_tool']);
  });

  it('throws McpAuthError on 401', async () => {
    const fetchImpl: FetchLike = async () => new Response('{"error":"invalid_token"}', { status: 401 });
    await expect(listTools(SERVER, 'bad-token', fetchImpl)).rejects.toBeInstanceOf(McpAuthError);
  });

  it('throws on a JSON-RPC error payload', async () => {
    const fetchImpl: FetchLike = async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as { id?: unknown; method: string };
      if (body.method === 'tools/list') {
        return new Response(
          JSON.stringify({ jsonrpc: '2.0', id: body.id, error: { code: -32000, message: 'scope missing' } }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      return jsonRpcResponse(body.id ?? null, {});
    };

    await expect(listTools(SERVER, 'token-abc', fetchImpl)).rejects.toThrow('tools/list failed: scope missing');
  });
});
