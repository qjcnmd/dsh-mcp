const OMIT_KEYS = new Set([
  'raw', 'envelope', 'history', 'events', 'trace', 'traces', 'credentials',
  'secret', 'token', 'apikey', 'password', 'authorization', 'cookie',
  'privatekey', 'secretkey', 'accesstoken', 'refreshtoken',
]);

export interface ProjectedToolResult {
  [key: string]: unknown;
  content: [{ type: 'text'; text: string }];
  structuredContent: Record<string, unknown>;
}

export function projectToolResult(
  value: object,
  summary = defaultSummary(value),
): ProjectedToolResult {
  return {
    content: [{ type: 'text', text: summary }],
    structuredContent: redactCredentialFields(value) as Record<string, unknown>,
  };
}

function redactCredentialFields(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactCredentialFields);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([key]) => !OMIT_KEYS.has(key.toLowerCase()))
      .map(([key, item]) => [key, redactCredentialFields(item)]),
  );
}

function defaultSummary(value: object): string {
  const record = value as Record<string, unknown>;
  if (isRecord(record.error) && typeof record.error.message === 'string') return record.error.message;
  if (typeof record.state === 'string') return `DSH turn state: ${record.state}.`;
  if (Array.isArray(record.items)) return `Returned ${record.items.length} items.`;
  if (typeof record.accepted === 'boolean') return record.accepted ? 'DSH operation accepted.' : 'DSH operation rejected.';
  return 'DSH operation completed.';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
