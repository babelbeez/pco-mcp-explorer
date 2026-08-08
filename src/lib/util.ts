// Small shared helpers.

export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function cleanString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function dedupe(values: string[]): string[] {
  return [...new Set(values)];
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;
