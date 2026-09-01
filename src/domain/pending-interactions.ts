export type PendingInteractionKind = 'question' | 'approval';

export interface QuestionOption {
  label: string;
  description?: string;
}

export interface PendingQuestion {
  id: string;
  question: string;
  detail?: string;
  header?: string;
  options: QuestionOption[];
  multiSelect: boolean;
  intent?: { kind: 'plan-review'; approve: string };
}

export interface PendingInteraction {
  pendingInteractionId: string;
  sessionId: string;
  turnRef: string | null;
  kind: PendingInteractionKind;
  prompt: string;
  options: QuestionOption[];
  questions?: PendingQuestion[];
  expiresAt: string | null;
}

export class PendingInteractionStore {
  private readonly records = new Map<string, PendingInteraction>();

  upsert(record: PendingInteraction): PendingInteraction {
    this.records.set(record.pendingInteractionId, structuredClone(record));
    return this.get(record.pendingInteractionId)!;
  }

  get(id: string): PendingInteraction | undefined {
    const record = this.records.get(id);
    return record === undefined ? undefined : structuredClone(record);
  }

  remove(id: string): void {
    this.records.delete(id);
  }

  list(sessionId?: string): PendingInteraction[] {
    return [...this.records.values()]
      .filter((record) => sessionId === undefined || record.sessionId === sessionId)
      .map((record) => structuredClone(record));
  }
}
