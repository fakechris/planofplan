export interface ScanRequest {
  kind: 'sessions' | 'usage' | 'experience';
  days: number;
  source: string;
  includeOfficial?: boolean;
  /** experience(INV-2169):安全门阈值与越门确认;days 不适用,沿用默认即可。 */
  maxNodes?: number;
  confirm?: boolean;
}

/** One scanner for the daemon, with at most one trailing request per kind. */
export class ScanQueue {
  private pending = new Map<ScanRequest['kind'], ScanRequest>();
  private running = false;
  constructor(private run: (request: ScanRequest) => Promise<void>, private onError: (error: unknown) => void) {}
  enqueue(request: ScanRequest): void {
    const old = this.pending.get(request.kind);
    this.pending.set(request.kind, old ? {
      ...request,
      days: Math.max(old.days, request.days),
      includeOfficial: old.includeOfficial || request.includeOfficial,
      maxNodes: old.maxNodes ?? request.maxNodes,
      // 确认只能收紧不能放宽:排队期间一旦有人带 --yes,合并请求保持可越门
      confirm: old.confirm || request.confirm,
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
