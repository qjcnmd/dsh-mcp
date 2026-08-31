export function disposableSessionId(): string {
  return `session-test-${crypto.randomUUID()}`;
}

export function disposableWorkspaceId(): string {
  return `workspace-test-${crypto.randomUUID()}`;
}

export function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
}

export function sseResponse(frames: unknown[]): Response {
  const body = frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join('');
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}
