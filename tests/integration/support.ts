import { disposableSessionId, disposableWorkspaceId } from '../unit/fixtures.js';

export interface DisposableTarget {
  workspaceId: string;
  sessionId: string;
}

export function makeDisposableTarget(): DisposableTarget {
  return { workspaceId: disposableWorkspaceId(), sessionId: disposableSessionId() };
}
