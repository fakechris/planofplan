/**
 * Where the daemon listens, and what a request must carry (INV-897).
 *
 * The HTTP API and the MCP endpoint hand out every local agent conversation, so the
 * default is loopback only. The Host-header check in server.ts stops DNS rebinding from a
 * browser; it is not authentication — anyone who can reach the port can send
 * `Host: localhost`. Listening anywhere else therefore requires a bearer token, and a
 * non-loopback address without one refuses to start rather than quietly exposing history.
 */
import { timingSafeEqual } from 'node:crypto';

export interface BindConfig {
  /**
   * Addresses to listen on. The default is both loopbacks: clients that resolve
   * `localhost` to ::1 first (the menubar's MCP URL, Node's fetch) must still connect.
   */
  hostnames: string[];
  /** Required on every request when set. Always set for a non-loopback address. */
  token: string | null;
}

export class BindError extends Error {}

export function isLoopbackHost(hostname: string): boolean {
  const bare = hostname.trim().toLowerCase().replace(/^\[|\]$/g, '');
  return bare === 'localhost' || bare === '::1' || /^127\.\d+\.\d+\.\d+$/.test(bare);
}

/** PLANOFPLAN_BIND (default: 127.0.0.1 and ::1) and PLANOFPLAN_TOKEN. */
export function resolveBind(env: Record<string, string | undefined> = process.env): BindConfig {
  const configured = env.PLANOFPLAN_BIND?.trim() || null;
  const hostnames = configured == null ? ['127.0.0.1', '::1'] : [configured];
  const token = env.PLANOFPLAN_TOKEN?.trim() || null;
  const hostname = configured ?? '127.0.0.1';
  if (!isLoopbackHost(hostname) && token == null) {
    throw new BindError(
      `PLANOFPLAN_BIND=${hostname} would expose every indexed agent conversation to that network. `
        + 'Set PLANOFPLAN_TOKEN as well (clients send Authorization: Bearer <token>), or leave PLANOFPLAN_BIND unset to stay on 127.0.0.1.',
    );
  }
  if (token != null && token.length < 16) {
    throw new BindError('PLANOFPLAN_TOKEN must be at least 16 characters.');
  }
  return { hostnames, token };
}

/** Whether an Authorization header carries exactly this bearer token, compared in constant time. */
export function bearerMatches(header: string | undefined, token: string): boolean {
  const match = /^Bearer\s+(.+)$/i.exec(header?.trim() ?? '');
  if (!match) return false;
  const given = Buffer.from(match[1]!.trim());
  const expected = Buffer.from(token);
  return given.length === expected.length && timingSafeEqual(given, expected);
}
