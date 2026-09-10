const OMIT_KEYS = new Set([
  'credentials',
  'secret', 'token', 'apikey', 'password', 'authorization', 'cookie',
  'privatekey', 'secretkey', 'accesstoken', 'refreshtoken',
]);

export interface ProjectedToolResult<T extends Record<string, unknown> = Record<string, unknown>> {
  [key: string]: unknown;
  content: Array<{ type: 'text'; text: string }>;
  structuredContent: T;
}

export function projectToolResult<const T extends Record<string, unknown>>(
  value: T,
  summary: string,
): ProjectedToolResult<T> {
  const structuredContent = redactCredentialFields(value) as T;
  return {
    content: [{ type: 'text', text: `${summary}\n${JSON.stringify(structuredContent)}` }],
    structuredContent,
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
