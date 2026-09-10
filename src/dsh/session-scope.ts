import { resolve } from 'node:path';
import { DshMcpError } from '../errors.js';
import { isRecord } from '../value-guards.js';
import type { SessionFollowSnapshot } from './event-client.js';

export function sameDirectory(left: string | undefined, right: string): boolean {
  if (left === undefined) return false;
  const normalize = (value: string) => process.platform === 'win32' ? resolve(value).toLowerCase() : resolve(value);
  return normalize(left) === normalize(right);
}

export function unsupportedSession(values: Record<string, unknown> | undefined): string | null {
  if (values?.agentPreset !== 'minimal') return 'Only the DSH minimal preset is supported.';
  if (!isRecord(values.permissions) || values.permissions.currentValue !== 'danger-full-access') return 'Only DSH sessions with danger-full-access permissions are supported.';
  return null;
}

export function assertSupportedSession(snapshot: SessionFollowSnapshot): void {
  const reason = unsupportedSession(snapshot.projections.values);
  if (reason !== null) throw new DshMcpError('unsupported-session', reason, { sessionId: snapshot.header.id });
}
