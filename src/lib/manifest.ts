// Tool manifest parsing and presentation helpers.
// Turns raw MCP tool descriptors into clean, human-readable rows:
// humanized titles, cleaned descriptions, parameter tables, and behavior badges.

import { isRecord } from './util';
import type { McpTool } from './mcp';

export interface ToolBehaviorBadge {
  label: string;
  severity: 'success' | 'info' | 'warn' | 'contrast';
}

export interface ToolInputParameter {
  name: string;
  type: string;
  required: boolean;
  description: string;
}

export interface ToolRow {
  name: string;
  displayTitle: string;
  summary: string;
  fullDescription: string;
  parameters: ToolInputParameter[];
  behaviorBadges: ToolBehaviorBadge[];
  /** The raw tool descriptor, for the "view JSON" detail. */
  raw: McpTool;
}

export function humanizeToolName(name: string): string {
  return name
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

export function resolveAnnotationTitle(annotations: unknown): string | null {
  if (!isRecord(annotations)) return null;
  const title = annotations.title;
  return typeof title === 'string' && title.trim() ? title.trim() : null;
}

export function resolveToolTitle(tool: McpTool): string {
  return tool.title?.trim() || resolveAnnotationTitle(tool.annotations) || humanizeToolName(tool.name);
}

/** Strips HTML comments, markdown artifacts, and excess whitespace from descriptions. */
export function cleanToolDescription(description: string): string {
  return description
    .replace(/<!--.*?-->/gs, ' ')
    .replace(/\r/g, '\n')
    .replace(/^>+/gm, ' ')
    .replace(/\n{2,}/g, '\n')
    .replace(/\s+/g, ' ')
    .replace(/#+\s*/g, '')
    .replace(/\*\*(.*?)\*\*/g, '$1')
    .replace(/\s+>\s*/g, ' ')
    .replace(/\s*<\s*/g, ' ')
    .replace(/[>\s]+$/g, '')
    .trim();
}

/** Builds a short summary by cutting machine-oriented doc tails from the description. */
export function buildToolSummary(tool: McpTool): string {
  const cleaned = cleanToolDescription(tool.description ?? '');

  if (!cleaned) {
    return 'No description provided.';
  }

  const cutPoints = [
    cleaned.indexOf(':param '),
    cleaned.indexOf(':return:'),
    cleaned.indexOf('Required scopes:'),
    cleaned.indexOf('Returns the result object.'),
  ].filter((index) => index > 0);

  const firstCutPoint = cutPoints.length ? Math.min(...cutPoints) : -1;
  const summary = firstCutPoint > 0 ? cleaned.slice(0, firstCutPoint).trim() : cleaned;

  return summary || cleaned;
}

export function normalizeTypeLabel(value: unknown): string {
  if (Array.isArray(value)) {
    const labels = value.map((item) => normalizeTypeLabel(item)).filter(Boolean);
    return labels.join(' | ');
  }
  if (typeof value === 'string' && value.trim()) {
    return value.trim();
  }
  return 'unknown';
}

export function extractInputParameters(schema: unknown): ToolInputParameter[] {
  if (!isRecord(schema)) return [];

  const properties = isRecord(schema.properties) ? schema.properties : null;
  const requiredSet = new Set(
    Array.isArray(schema.required)
      ? schema.required.filter((item): item is string => typeof item === 'string')
      : [],
  );

  if (!properties) return [];

  return Object.entries(properties).map(([name, value]) => {
    const property = isRecord(value) ? value : {};
    return {
      name,
      type: normalizeTypeLabel(property.type),
      required: requiredSet.has(name),
      description:
        typeof property.description === 'string' && property.description.trim()
          ? property.description.trim()
          : 'No description provided.',
    };
  });
}

export function extractBehaviorBadges(annotations: unknown): ToolBehaviorBadge[] {
  if (!isRecord(annotations)) return [];

  const badges: ToolBehaviorBadge[] = [];

  if (annotations.readOnlyHint === true) {
    badges.push({ label: 'Read-only', severity: 'success' });
  }
  if (annotations.destructiveHint === true) {
    badges.push({ label: 'Destructive', severity: 'warn' });
  }
  if (annotations.idempotentHint === true) {
    badges.push({ label: 'Idempotent', severity: 'info' });
  }
  if (annotations.openWorldHint === true) {
    badges.push({ label: 'External system', severity: 'contrast' });
  } else if (annotations.openWorldHint === false) {
    badges.push({ label: 'Closed system', severity: 'info' });
  }

  return badges;
}

export function buildToolRows(tools: McpTool[]): ToolRow[] {
  return tools.map((tool) => ({
    name: tool.name,
    displayTitle: resolveToolTitle(tool),
    summary: buildToolSummary(tool),
    fullDescription: cleanToolDescription(tool.description ?? ''),
    parameters: extractInputParameters(tool.inputSchema),
    behaviorBadges: extractBehaviorBadges(tool.annotations),
    raw: tool,
  }));
}

/** Case-insensitive search across title, id, description, and parameter names. */
export function filterToolRows(rows: ToolRow[], query: string): ToolRow[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return rows;
  return rows.filter((row) => {
    return (
      row.name.toLowerCase().includes(needle) ||
      row.displayTitle.toLowerCase().includes(needle) ||
      row.fullDescription.toLowerCase().includes(needle) ||
      row.parameters.some((parameter) => parameter.name.toLowerCase().includes(needle))
    );
  });
}
