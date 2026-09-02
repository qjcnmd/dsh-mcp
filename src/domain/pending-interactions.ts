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
}

export interface PendingInteraction {
  pendingInteractionId: string;
  sessionId: string;
  turnRef: string | null;
  kind: 'question' | 'approval';
  prompt: string;
  options: QuestionOption[];
  questions?: PendingQuestion[];
}

export function publicPendingInteraction(value: PendingInteraction): Record<string, unknown> {
  if (value.kind === 'approval') return { kind: 'approval', pendingInteractionId: value.pendingInteractionId, sessionId: value.sessionId, prompt: value.prompt, options: value.options.map((option) => ({ outcome: option.label, label: option.label })) };
  return { kind: 'question', pendingInteractionId: value.pendingInteractionId, sessionId: value.sessionId, questions: value.questions ?? [] };
}

export class PendingInteractionStore {
  private readonly records = new Map<string, PendingInteraction>();

  upsert(record: PendingInteraction): void {
    this.records.set(record.pendingInteractionId, structuredClone(record));
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
