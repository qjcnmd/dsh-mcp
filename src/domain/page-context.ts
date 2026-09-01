export class PageContextStore {
  private sessionId: string | null = null;

  selectSession(sessionId: string): void {
    this.sessionId = sessionId;
  }

  selectedSessionId(): string | null {
    return this.sessionId;
  }
}
