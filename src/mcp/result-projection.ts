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
  summary: string,
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
