import type { DshConfig } from '../config.js';

export type DshEventStream = 'mux' | 'host';

export interface DshEvent {
  stream: DshEventStream;
  rpcId: string;
  method: string;
  payload: unknown;
  order: number;
  receivedAt: string;
}

export type DshEventListener = (event: DshEvent) => void;
export type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export class DshEventClient {
  private readonly listeners = new Set<DshEventListener>();
  private controller: AbortController | null = null;
  private running = false;
  private order = 0;
  private readonly fetchImpl: FetchLike;

  constructor(private readonly config: DshConfig, fetchImpl: FetchLike = globalThis.fetch) {
    this.fetchImpl = fetchImpl;
  }

  subscribe(listener: DshEventListener, signal?: AbortSignal): () => void {
    this.listeners.add(listener);
    if (!this.running) this.start();
    const unsubscribe = () => {
      this.listeners.delete(listener);
      if (this.listeners.size === 0) void this.stop();
    };
    if (signal !== undefined) {
      if (signal.aborted) unsubscribe();
      else signal.addEventListener('abort', unsubscribe, { once: true });
    }
    return unsubscribe;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.controller = new AbortController();
    void this.runStream('mux', this.controller.signal);
    void this.runStream('host', this.controller.signal);
  }

  async stop(): Promise<void> {
    this.running = false;
    this.controller?.abort();
    this.controller = null;
  }

  private async runStream(stream: DshEventStream, signal: AbortSignal): Promise<void> {
    const path = stream === 'mux' ? '/api/events.mux' : '/api/events.host';
    let lastError: unknown;
    for (let attempt = 0; attempt < 3 && !signal.aborted; attempt += 1) {
      try {
        const connectController = new AbortController();
        const timer = setTimeout(() => connectController.abort(), this.config.streamConnectTimeoutMs);
        let response: Response;
        try {
          response = await this.fetchImpl(new URL(path, this.config.baseUrl), {
            headers: { accept: 'text/event-stream' },
            signal: AbortSignal.any([signal, connectController.signal]),
          });
        } finally {
          clearTimeout(timer);
        }
        if (!response.ok || response.body === null) throw new Error(`DSH ${stream} event stream returned HTTP ${response.status}`);
        const status = await this.consumeSse(stream, response.body, signal);
        if (status !== 'aborted') return;
        return;
      } catch (error) {
        if (signal.aborted) return;
        lastError = error;
        await new Promise((resolve) => setTimeout(resolve, this.config.reconnectDelayMs));
      }
    }
    if (!signal.aborted) this.emit({ stream, rpcId: '', method: 'stream/error', payload: { message: lastError instanceof Error ? lastError.message : String(lastError ?? 'event stream unavailable') }, order: this.nextOrder(), receivedAt: new Date().toISOString() });
  }

  private async consumeSse(stream: DshEventStream, body: ReadableStream<Uint8Array>, signal: AbortSignal): Promise<'closed' | 'aborted'> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      while (!signal.aborted) {
        const { done, value } = await reader.read();
        if (done) return signal.aborted ? 'aborted' : 'closed';
        buffer += decoder.decode(value, { stream: true });
        let boundary = buffer.indexOf('\n\n');
        while (boundary >= 0) {
          const frame = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          this.consumeFrame(stream, frame);
          boundary = buffer.indexOf('\n\n');
        }
      }
    } finally {
      await reader.cancel().catch(() => undefined);
    }
    return signal.aborted ? 'aborted' : 'closed';
  }

  private consumeFrame(stream: DshEventStream, frame: string): void {
    const data = frame.split('\n').filter((line) => line.startsWith('data: ')).map((line) => line.slice(6)).join('');
    if (data === '') return;
    let envelope: unknown;
    try { envelope = JSON.parse(data) as unknown; } catch { return; }
    if (!isRecord(envelope) || envelope.type !== 'server-request' || typeof envelope.rpcId !== 'string' || typeof envelope.method !== 'string') return;
    this.emit({ stream, rpcId: envelope.rpcId, method: envelope.method, payload: envelope.payload, order: this.nextOrder(), receivedAt: new Date().toISOString() });
  }

  private nextOrder(): number {
    this.order += 1;
    return this.order;
  }

  private emit(event: DshEvent): void {
    for (const listener of this.listeners) {
      try { listener(event); } catch { /* listener failures cannot break the shared stream */ }
    }
  }
}
