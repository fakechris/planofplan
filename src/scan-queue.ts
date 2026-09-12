export interface ScanRequest {
  kind: 'sessions' | 'usage';
  days: number;
  source: string;
  includeOfficial?: boolean;
}

/** One scanner for the daemon, with at most one trailing request per kind. */
export class ScanQueue {
  private pending = new Map<ScanRequest['kind'], ScanRequest>();
  private running = false;
  constructor(private run: (request: ScanRequest) => Promise<void>, private onError: (error: unknown) => void) {}
  enqueue(request: ScanRequest): void {
    const old = this.pending.get(request.kind);
    this.pending.set(request.kind, old ? {
      ...request, days: Math.max(old.days, request.days), includeOfficial: old.includeOfficial || request.includeOfficial,
    } : request);
    void this.drain();
  }
  private async drain(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      while (this.pending.size) {
        const [kind, request] = this.pending.entries().next().value!;
        this.pending.delete(kind);
        try { await this.run(request); } catch (error) { this.onError(error); }
      }
    } finally { this.running = false; }
  }
}
