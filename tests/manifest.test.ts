import { describe, expect, it } from 'vitest';

import {
  buildToolRows,
  buildToolSummary,
  cleanToolDescription,
  extractBehaviorBadges,
  extractInputParameters,
  filterToolRows,
  humanizeToolName,
  resolveToolTitle,
} from '../src/lib/manifest';
import type { McpTool } from '../src/lib/mcp';

describe('humanizeToolName', () => {
  it('converts snake/kebab case to title case', () => {
    expect(humanizeToolName('get_person_details')).toBe('Get Person Details');
    expect(humanizeToolName('list-check-ins')).toBe('List Check Ins');
    expect(humanizeToolName('  extra__spaces  ')).toBe('Extra Spaces');
  });
});

describe('resolveToolTitle', () => {
  it('prefers the explicit title, then annotation title, then humanized name', () => {
    expect(resolveToolTitle({ name: 'get_people', title: 'Get People' })).toBe('Get People');
    expect(
      resolveToolTitle({ name: 'get_people', annotations: { title: 'People lookup' } }),
    ).toBe('People lookup');
    expect(resolveToolTitle({ name: 'get_people' })).toBe('Get People');
  });
});

describe('cleanToolDescription', () => {
  it('strips HTML comments and markdown artifacts', () => {
    expect(cleanToolDescription('<!-- internal --> **Bold** intro\n\n## Notes\n> quote')).toBe(
      'Bold intro Notes quote',
    );
  });

  it('collapses whitespace and trims', () => {
    expect(cleanToolDescription('  hello \n\n\n world  ')).toBe('hello world');
  });
});

describe('buildToolSummary', () => {
  it('cuts machine-oriented doc tails', () => {
    const tool: McpTool = {
      name: 'get_people',
      description:
        'Lists people in the account. Required scopes: mcp:people:read :param page: page number',
    };
    expect(buildToolSummary(tool)).toBe('Lists people in the account.');
  });

  it('falls back when there is no description', () => {
    expect(buildToolSummary({ name: 'x' })).toBe('No description provided.');
  });
});

describe('extractInputParameters', () => {
  it('extracts properties with types, required flags, and descriptions', () => {
    const params = extractInputParameters({
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query' },
        limit: { type: ['integer', 'null'] },
      },
      required: ['query'],
    });
    expect(params).toEqual([
      { name: 'query', type: 'string', required: true, description: 'Search query' },
      { name: 'limit', type: 'integer | null', required: false, description: 'No description provided.' },
    ]);
  });

  it('returns empty for non-object schemas', () => {
    expect(extractInputParameters(null)).toEqual([]);
    expect(extractInputParameters({ type: 'object' })).toEqual([]);
  });
});

describe('extractBehaviorBadges', () => {
  it('maps annotation hints to badges', () => {
    expect(
      extractBehaviorBadges({
        readOnlyHint: true,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      }),
    ).toEqual([
      { label: 'Read-only', severity: 'success' },
      { label: 'Destructive', severity: 'warn' },
      { label: 'Idempotent', severity: 'info' },
      { label: 'Closed system', severity: 'info' },
    ]);
  });

  it('returns nothing without annotations', () => {
    expect(extractBehaviorBadges(undefined)).toEqual([]);
    expect(extractBehaviorBadges({ readOnlyHint: false, destructiveHint: false })).toEqual([]);
  });
});

describe('buildToolRows + filterToolRows', () => {
  const tools: McpTool[] = [
    {
      name: 'people_search',
      title: 'Search people',
      description: 'Finds people. Required scopes: mcp:people:read',
      inputSchema: { type: 'object', properties: { query: { type: 'string' } } },
      annotations: { readOnlyHint: true },
    },
    { name: 'delete_person', description: 'Removes a person record.' },
  ];

  it('builds rows with derived presentation fields', () => {
    const rows = buildToolRows(tools);
    expect(rows).toHaveLength(2);
    expect(rows[0].displayTitle).toBe('Search people');
    expect(rows[0].summary).toBe('Finds people.');
    expect(rows[0].behaviorBadges).toEqual([{ label: 'Read-only', severity: 'success' }]);
    expect(rows[1].displayTitle).toBe('Delete Person');
  });

  it('filters across name, title, description, and parameter names', () => {
    const rows = buildToolRows(tools);
    expect(filterToolRows(rows, 'people')).toHaveLength(1); // name + title + description of people_search
    expect(filterToolRows(rows, 'person')).toHaveLength(1); // delete_person name + description
    expect(filterToolRows(rows, 'query')).toHaveLength(1); // parameter name
    expect(filterToolRows(rows, 'removes')).toHaveLength(1);
    expect(filterToolRows(rows, 'nonexistent')).toHaveLength(0);
    expect(filterToolRows(rows, '')).toHaveLength(2);
  });
});
