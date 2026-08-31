export interface ProjectionOptions {
  maxTextChars?: number;
  maxItems?: number;
  maxDepth?: number;
}

const DEFAULTS: Required<ProjectionOptions> = { maxTextChars: 4_000, maxItems: 20, maxDepth: 6 };
const OMIT_KEYS = new Set(['raw', 'envelope', 'history', 'events', 'trace', 'traces', 'credentials', 'secret', 'token']);

export function truncateText(value: string, maxChars = DEFAULTS.maxTextChars): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, Math.max(0, maxChars - 1))}…`;
}

export function projectBounded(value: unknown, options: ProjectionOptions = {}, depth = 0): unknown {
  const config = { ...DEFAULTS, ...options };
  if (typeof value === 'string') return truncateText(value, config.maxTextChars);
  if (value === null || typeof value === 'number' || typeof value === 'boolean') return value;
  if (depth >= config.maxDepth) return '[depth-limited]';
  if (Array.isArray(value)) return value.slice(0, config.maxItems).map((item) => projectBounded(item, config, depth + 1));
  if (typeof value === 'object') {
    const output: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (OMIT_KEYS.has(key.toLowerCase())) continue;
      output[key] = projectBounded(item, config, depth + 1);
    }
    return output;
  }
  return String(value);
}

export function summarize(value: unknown, options: ProjectionOptions = {}): string {
  const projected = projectBounded(value, options);
  const text = typeof projected === 'string' ? projected : JSON.stringify(projected);
  return truncateText(text ?? 'null', options.maxTextChars ?? DEFAULTS.maxTextChars);
}

export interface ProjectedToolResult {
  content: [{ type: 'text'; text: string }];
  structuredContent: Record<string, unknown>;
}

export function projectToolResult(value: Record<string, unknown>, options: ProjectionOptions = {}): ProjectedToolResult {
  const projected = projectBounded(value, options);
  const structuredContent = (typeof projected === 'object' && projected !== null && !Array.isArray(projected)) ? projected as Record<string, unknown> : { value: projected };
  return { content: [{ type: 'text', text: summarize(structuredContent, options) }], structuredContent };
}
