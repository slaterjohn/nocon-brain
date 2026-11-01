import type { Clock } from "@ncb/shared";

export interface ServerEvent {
  id: number;
  type: string;
  at: string;
  data: unknown;
}

/**
 * In-process event bus behind `GET /api/system/events`. Keeps a ring buffer so a reconnecting client can
 * resume with `Last-Event-ID`. Event ids restart at 1 each time the server starts, so a client that
 * presents an id from before a restart simply receives the retained tail.
 */
export class EventBus {
  private seq = 0;
  private readonly ring: ServerEvent[] = [];
  private readonly listeners = new Set<(e: ServerEvent) => void>();

  constructor(private readonly clock: Clock, private readonly capacity = 500) {}

  publish(type: string, data: unknown): ServerEvent {
    const e: ServerEvent = { id: ++this.seq, type, at: new Date(this.clock.now()).toISOString(), data };
    this.ring.push(e);
    if (this.ring.length > this.capacity) this.ring.shift();
    for (const l of this.listeners) {
      try {
        l(e);
      } catch {
        /* a broken subscriber must not stop the others */
      }
    }
    return e;
  }

  subscribe(fn: (e: ServerEvent) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Events with an id greater than `afterId`. */
  since(afterId: number): ServerEvent[] {
    return this.ring.filter((e) => e.id > afterId);
  }

  get lastId(): number {
    return this.seq;
  }
}

export function formatSse(e: { id?: number; type: string; data: unknown }): string {
  const idLine = e.id === undefined ? "" : `id: ${e.id}\n`;
  return `${idLine}event: ${e.type}\ndata: ${JSON.stringify(e.data)}\n\n`;
}
