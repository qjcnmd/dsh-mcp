import { readFile } from 'node:fs/promises';

export type CapabilitySupport = 'structured' | 'unsupported' | 'pending' | 'out_of_scope';
export type CapabilityTargetKind = 'none' | 'workspace' | 'session' | 'turn' | 'pendingInteraction';

export interface CapabilityEntry {
  capabilityId: string;
  surfaceRegion: string;
  label: string;
  userOperation: string;
  sourceOperation: string | null;
  toolName: string | null;
  targetKind: CapabilityTargetKind;
  support: CapabilitySupport;
  resultProjection: string;
  verifiedAgainst: string;
}

export interface CapabilityInventory {
  captureDate: string;
  dshPackage: string;
  endpoint: string;
  entries: CapabilityEntry[];
}

export interface CoverageReport {
  ok: boolean;
  missing: string[];
}

export async function loadCapabilityInventory(path: string): Promise<CapabilityInventory> {
  return parseCapabilityInventory(await readFile(path, 'utf8'));
}

export function parseCapabilityInventory(markdown: string): CapabilityInventory {
  const captureDate = markdown.match(/^Capture date:\s*(.+)$/m)?.[1]?.trim() ?? 'unknown';
  const dshPackage = markdown.match(/^DSH package:\s*(.+)$/m)?.[1]?.trim() ?? 'unknown';
  const endpoint = markdown.match(/^Endpoint:\s*(.+)$/m)?.[1]?.trim() ?? 'unknown';
  const tableLines = markdown.split(/\r?\n/).filter((line) => line.startsWith('|'));
  const entries: CapabilityEntry[] = [];
  for (const line of tableLines.slice(2)) {
    const columns = line.split('|').slice(1, -1).map((column) => column.trim());
    if (columns.length < 6 || !/^WS-\d+$/i.test(columns[0] ?? '')) continue;
    const [capabilityId, control, userOperation, sourceOperation, supportText, notes] = columns;
    const support = normalizeSupport(supportText ?? 'pending');
    entries.push({
      capabilityId: capabilityId!,
      surfaceRegion: inferRegion(control ?? ''),
      label: (control ?? userOperation ?? capabilityId!).trim(),
      userOperation: userOperation ?? '',
      sourceOperation: sourceOperation && !/^[-—]$/.test(sourceOperation) ? sourceOperation : null,
      toolName: null,
      targetKind: inferTargetKind(userOperation ?? ''),
      support,
      resultProjection: notes ?? 'bounded',
      verifiedAgainst: `${dshPackage} ${captureDate}`,
    });
  }
  return { captureDate, dshPackage, endpoint, entries };
}

export function assertCapabilityCoverage(inventory: CapabilityInventory, registeredToolNames: Iterable<string>): CoverageReport {
  const tools = new Set(registeredToolNames);
  const missing = inventory.entries
    .filter((entry) => entry.support === 'structured' && entry.toolName !== null && !tools.has(entry.toolName))
    .map((entry) => entry.capabilityId);
  return { ok: missing.length === 0, missing };
}

function normalizeSupport(value: string): CapabilitySupport {
  const normalized = value.toLowerCase();
  if (normalized.includes('structured')) return 'structured';
  if (normalized.includes('unsupported')) return 'unsupported';
  if (normalized.includes('out_of_scope') || normalized.includes('out-of-scope')) return 'out_of_scope';
  return 'pending';
}

function inferRegion(value: string): string {
  const lower = value.toLowerCase();
  if (lower.includes('workspace')) return 'workspace';
  if (lower.includes('session')) return 'session';
  if (lower.includes('model')) return 'model';
  if (lower.includes('queue')) return 'queue';
  if (lower.includes('question') || lower.includes('approval')) return 'intervention';
  return 'conversation';
}

function inferTargetKind(value: string): CapabilityTargetKind {
  const lower = value.toLowerCase();
  if (lower.includes('workspace')) return 'workspace';
  if (lower.includes('turn') || lower.includes('generation')) return 'turn';
  if (lower.includes('approval') || lower.includes('question')) return 'pendingInteraction';
  if (lower.includes('session') || lower.includes('message') || lower.includes('model') || lower.includes('queue')) return 'session';
  return 'none';
}
