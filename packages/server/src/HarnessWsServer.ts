import { createHash, timingSafeEqual } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { WebSocket, WebSocketServer, type RawData } from 'ws';
import { clampPayloadDeadline, parseEnvelope, SUPPORTED_MAJOR, type Envelope } from '@deskpet/contracts';
import type { OperationStore, StoreChange } from '@deskpet/harness';
import { fromStoreChange, snapshotFromHarness } from '@deskpet/projector';
import type { HarnessInbound } from './inbound.js';
import { UnsupportedKindError } from './inbound.js';
import { CLOSE, ClientFrame, PROTOCOL, type ErrorCode, type Role, type ServerFrame } from './protocol.js';

/**
 * Harness 서비스 경계 (WebSocket). 근거: message-contracts §Envelope, §Output and Projection, Liability §Ownership.
 *
 * 규칙
 * - 기본 바인딩은 127.0.0.1. 첫 프레임 hello의 토큰으로 인증한다 (프로세스 간 호출은 인증된 경계).
 * - 브라우저(Origin 헤더 있음)는 allowedOrigins에 있는 Origin만 받는다.
 * - 역할: pipeline = 실행·구독, viewer = 구독만.
 * - 연결 끊김은 취소가 아니다. 진행 중인 요청은 끝까지 처리하고 결과는 Harness 기록에 남는다.
 *   같은 messageId 재전송 → 같은 응답, 같은 turnId 재전송 → Harness가 저장된 결과를 돌려준다.
 * - Envelope 검증 실패·지원하지 않는 kind·major는 실행 전에 거부한다.
 * - 상한: 메시지 크기, 연결당 동시 요청 수, 송신 버퍼(느린 구독자는 끊는다 — Harness를 막지 않음).
 * - 구독: snapshot(scope=source 전체, epoch) 1회 → 이후 변경 이벤트. 클라이언트는 더 높은 revision만 적용한다.
 */
export interface HarnessWsServerOptions {
  inbound: HarnessInbound;
  /** 상태 이벤트·snapshot 원본 */
  store: Pick<OperationStore, 'subscribe' | 'readProjectionSnapshot'>;
  /** pipeline 토큰: 실행 + 구독 */
  token: string;
  /** viewer 전용 토큰(선택): 구독만. 브라우저 화면에는 이 토큰만 넣는다 */
  viewerToken?: string;
  host?: string;
  port?: number;
  allowedOrigins?: string[];
  maxPayloadBytes?: number;
  maxInFlightPerConnection?: number;
  maxBufferedBytes?: number;
  helloTimeoutMs?: number;
  /** 같은 messageId 응답을 기억하는 개수 */
  replayCacheSize?: number;
  /** 서버 전체 동시 처리 상한 (연결 수와 무관). 기본 32 */
  maxInFlightTotal?: number;
  /** snapshot 전송 전에 모아 둘 이벤트 상한. 넘으면 그 연결을 닫아 다시 구독하게 한다. 기본 1000 */
  maxPendingEvents?: number;
  now?: () => number;
  log?: (line: string) => void;
}

interface Conn {
  id: number;
  ws: WebSocket;
  role?: Role;
  inFlight: number;
  subscribed: boolean;
  /** snapshot 전송 전에 들어온 이벤트 */
  pendingEvents: unknown[] | null;
}

interface CachedReply {
  fingerprint: string;
  reply: Promise<ServerFrame>;
}

export class HarnessWsServer {
  private wss?: WebSocketServer;
  private readonly conns = new Set<Conn>();
  private readonly inFlight = new Set<Promise<unknown>>();
  private readonly replies = new Map<string, CachedReply>();
  private readonly tokenDigest: Buffer;
  private readonly viewerDigest?: Buffer;
  private readonly epoch = Date.now();
  private unsubscribe?: () => void;
  private stopping = false;
  private nextId = 0;
  private readonly log: (line: string) => void;

  constructor(private readonly o: HarnessWsServerOptions) {
    if (!o.token || o.token.length < 16) throw new Error('server token must be at least 16 characters');
    this.tokenDigest = digest(o.token);
    if (o.viewerToken !== undefined) {
      if (o.viewerToken.length < 16) throw new Error('viewer token must be at least 16 characters');
      if (o.viewerToken === o.token) throw new Error('viewer token must differ from the pipeline token');
      this.viewerDigest = digest(o.viewerToken);
    }
    this.log = o.log ?? (() => {});
  }

  async start(): Promise<{ host: string; port: number }> {
    const host = this.o.host ?? '127.0.0.1';
    const allowed = new Set(this.o.allowedOrigins ?? []);
    this.wss = new WebSocketServer({
      host,
      port: this.o.port ?? 8787,
      maxPayload: this.o.maxPayloadBytes ?? 256 * 1024,
      verifyClient: (info, done) => {
        const origin = info.origin;
        if (origin && !allowed.has(origin)) {
          this.log(`거부: 허용되지 않은 Origin ${origin}`);
          return done(false, 403, 'origin not allowed');
        }
        done(true);
      },
    });
    this.wss.on('connection', (ws) => this.onConnection(ws));
    this.unsubscribe = this.o.store.subscribe((c) => this.broadcast(c));
    await new Promise<void>((resolve, reject) => {
      this.wss!.once('listening', resolve);
      this.wss!.once('error', reject);
    });
    const addr = this.wss.address() as AddressInfo;
    this.log(`Harness WebSocket 서버 ws://${host}:${addr.port} (protocol ${PROTOCOL}, epoch ${this.epoch})`);
    return { host, port: addr.port };
  }

  /** 새 연결을 받지 않고, 진행 중 요청이 끝나길 기다린 뒤(최대 drainMs) 연결을 닫는다 */
  async stop(drainMs = 30_000): Promise<void> {
    this.stopping = true;
    this.unsubscribe?.();
    const wss = this.wss;
    if (!wss) return;
    const drained = Promise.allSettled([...this.inFlight]);
    await Promise.race([drained, new Promise((r) => setTimeout(r, drainMs))]);
    for (const c of this.conns) c.ws.close(CLOSE.shuttingDown, 'server shutting down');
    await new Promise<void>((resolve) => wss.close(() => resolve()));
    this.log('Harness WebSocket 서버 종료');
  }

  /** 테스트·진단용 */
  get connectionCount(): number {
    return this.conns.size;
  }
  inFlightIdle(): Promise<void> {
    return Promise.allSettled([...this.inFlight]).then(() => undefined);
  }

  // ---------------------------------------------------------------- connection
  private onConnection(ws: WebSocket) {
    const conn: Conn = { id: ++this.nextId, ws, inFlight: 0, subscribed: false, pendingEvents: null };
    this.conns.add(conn);
    const helloTimer = setTimeout(() => {
      if (!conn.role) ws.close(CLOSE.helloTimeout, 'hello timeout');
    }, this.o.helloTimeoutMs ?? 5_000);
    ws.on('message', (data, isBinary) => {
      if (isBinary) return this.protocolError(conn, 'invalid_frame', 'binary frames are not supported');
      void this.onMessage(conn, data);
    });
    ws.on('close', () => {
      clearTimeout(helloTimer);
      this.conns.delete(conn);
      // 끊김은 취소가 아니다: 진행 중 요청은 계속 처리된다
      if (conn.role) this.log(`연결 종료 #${conn.id} (${conn.role})${conn.inFlight ? `, 처리 중 요청 ${conn.inFlight}건은 계속 진행` : ''}`);
    });
    ws.on('error', () => ws.terminate());
  }

  private async onMessage(conn: Conn, data: RawData) {
    let raw: unknown;
    try {
      raw = JSON.parse(data.toString());
    } catch {
      return this.protocolError(conn, 'invalid_frame', 'not JSON');
    }
    const f = ClientFrame.safeParse(raw);
    if (!f.success) return this.protocolError(conn, 'invalid_frame', f.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
    const frame = f.data;

    if (!conn.role) {
      if (frame.type !== 'hello') {
        this.send(conn, { type: 'error', code: 'hello_required', message: 'first frame must be hello' });
        return conn.ws.close(CLOSE.unauthorized, 'hello required');
      }
      // pipeline 토큰은 두 역할 모두, viewer 토큰은 viewer 역할만 허용한다 (역할은 토큰이 정한다)
      const d = digest(frame.token);
      const isPipeline = timingSafeEqual(d, this.tokenDigest);
      const isViewer = !!this.viewerDigest && timingSafeEqual(d, this.viewerDigest);
      if (!isPipeline && !(isViewer && frame.role === 'viewer')) {
        this.log(`거부: 토큰 불일치 (#${conn.id})`);
        this.send(conn, { type: 'error', code: 'unauthorized', message: 'invalid token' });
        return conn.ws.close(CLOSE.unauthorized, 'unauthorized');
      }
      conn.role = frame.role;
      this.log(`연결 #${conn.id} 인증됨 (${frame.role}${frame.client ? `, ${frame.client}` : ''})`);
      return this.send(conn, { type: 'welcome', protocol: PROTOCOL, schemaVersion: `${SUPPORTED_MAJOR}.0`, role: frame.role, epoch: this.epoch, serverTime: new Date().toISOString() });
    }

    switch (frame.type) {
      case 'hello':
        return this.protocolError(conn, 'invalid_frame', 'already authenticated');
      case 'ping':
        return this.send(conn, { type: 'pong', id: frame.id });
      case 'subscribe':
        return this.subscribe(conn);
      case 'request':
        return this.onRequest(conn, frame.envelope);
    }
  }

  // ------------------------------------------------------------------- requests
  private async onRequest(conn: Conn, rawEnvelope: unknown) {
    const ids = peekIds(rawEnvelope);
    const fail = (code: ErrorCode, message: string, issues?: string[]): ServerFrame => ({
      type: 'reply',
      causationId: ids.messageId,
      requestId: ids.requestId,
      ok: false,
      error: { code, message, ...(issues ? { issues } : {}) },
    });
    if (conn.role !== 'pipeline') return this.send(conn, fail('forbidden', 'viewer connections cannot execute requests'));
    if (this.stopping) return this.send(conn, fail('shutting_down', 'server is shutting down'));

    const parsed = parseEnvelope(rawEnvelope);
    if (!parsed.ok) return this.send(conn, fail('invalid_message', 'envelope rejected before execution', parsed.issues));
    const env = parsed.value;
    if (!this.o.inbound.kinds.has(env.kind)) return this.send(conn, fail('unsupported_kind', `kind ${env.kind} is not accepted`));

    // 같은 messageId 재전달 → 같은 응답 (실행은 한 번). 내용이 다르면 거부
    const fingerprint = fingerprintOf(env);
    const cached = this.replies.get(env.messageId);
    if (cached) {
      if (cached.fingerprint !== fingerprint) return this.send(conn, fail('invalid_message', 'messageId reused with different content'));
      return this.send(conn, await cached.reply);
    }
    // 이미 기한이 지난 요청은 실행하지 않는다. 위의 재전달 응답은 실행 결과이므로 그대로 돌려준다 (감사 F-05)
    if (env.deadlineAt && Date.parse(env.deadlineAt) <= (this.o.now ?? Date.now)()) return this.send(conn, fail('deadline_exceeded', 'envelope deadline already passed; not executed'));
    if (this.inFlight.size >= (this.o.maxInFlightTotal ?? 32)) return this.send(conn, fail('too_many_in_flight', 'server is at its concurrent request limit'));
    if (conn.inFlight >= (this.o.maxInFlightPerConnection ?? 8)) return this.send(conn, fail('too_many_in_flight', 'too many concurrent requests on this connection'));

    conn.inFlight += 1;
    const reply = this.execute(clampPayloadDeadline(env));
    this.remember(env.messageId, { fingerprint, reply });
    this.inFlight.add(reply);
    try {
      const frame = await reply;
      this.send(conn, frame); // 연결이 끊겼으면 보내지 않는다. 결과는 Harness 기록·같은 turnId 재전송으로 얻는다
    } finally {
      conn.inFlight -= 1;
      this.inFlight.delete(reply);
    }
  }

  private async execute(env: Envelope): Promise<ServerFrame> {
    try {
      const r = await this.o.inbound.dispatch(env);
      return { type: 'reply', causationId: env.messageId, requestId: env.requestId, ok: true, kind: r.kind, payload: r.payload };
    } catch (e) {
      if (e instanceof UnsupportedKindError) return { type: 'reply', causationId: env.messageId, requestId: env.requestId, ok: false, error: { code: 'unsupported_kind', message: e.message } };
      // 내부 오류 내용은 서버 로그에만 남긴다 (비밀값이 섞일 수 있는 원문은 응답에 넣지 않음)
      this.log(`요청 처리 오류 ${env.kind} [${env.requestId}]: ${e instanceof Error ? e.name : 'error'}`);
      return { type: 'reply', causationId: env.messageId, requestId: env.requestId, ok: false, error: { code: 'internal', message: 'request failed inside the harness; check the request state before retrying' } };
    }
  }

  private remember(messageId: string, c: CachedReply) {
    this.replies.set(messageId, c);
    const cap = this.o.replayCacheSize ?? 1_000;
    while (this.replies.size > cap) this.replies.delete(this.replies.keys().next().value!);
  }

  // ------------------------------------------------------------------ subscribe
  /** 다시 구독하면(불완전 동기화 복구) 새 snapshot을 보낸다 */
  private async subscribe(conn: Conn) {
    conn.subscribed = true;
    // snapshot을 읽기 전에 이벤트 수집을 시작한다 → snapshot 이후 누락 없음 (message-contracts §Projection)
    conn.pendingEvents = [];
    const records = await this.o.store.readProjectionSnapshot();
    this.send(conn, { type: 'snapshot', snapshot: snapshotFromHarness(records, this.epoch) });
    const queued = conn.pendingEvents ?? [];
    conn.pendingEvents = null;
    for (const e of queued) this.send(conn, { type: 'event', event: e });
  }

  private broadcast(c: StoreChange) {
    const event = fromStoreChange(c, this.epoch);
    for (const conn of this.conns) {
      if (!conn.subscribed) continue;
      if (conn.pendingEvents) {
        // 구독 snapshot을 만드는 동안 이벤트가 너무 많이 쌓이면 메모리를 지키기 위해 연결을 닫는다. 클라이언트는 다시 연결해 새 snapshot을 받는다 (감사 F-07)
        if (conn.pendingEvents.length >= (this.o.maxPendingEvents ?? 1_000)) {
          conn.pendingEvents = [];
          conn.subscribed = false;
          this.log(`구독 이벤트 대기열 초과 #${conn.id} — 연결을 닫아 다시 동기화하게 합니다`);
          conn.ws.close(CLOSE.slowConsumer, 'resync required');
          continue;
        }
        conn.pendingEvents.push(event);
      }
      else this.send(conn, { type: 'event', event });
    }
  }

  // -------------------------------------------------------------------- output
  private send(conn: Conn, frame: ServerFrame) {
    if (conn.ws.readyState !== WebSocket.OPEN) return;
    if (conn.ws.bufferedAmount > (this.o.maxBufferedBytes ?? 1024 * 1024)) {
      this.log(`느린 연결 #${conn.id} 종료 (송신 버퍼 초과)`);
      conn.ws.close(CLOSE.slowConsumer, 'slow consumer');
      return;
    }
    conn.ws.send(JSON.stringify(frame));
  }

  private protocolError(conn: Conn, code: ErrorCode, message: string) {
    this.send(conn, { type: 'error', code, message });
  }
}

function digest(s: string): Buffer {
  return createHash('sha256').update(s).digest();
}

function fingerprintOf(env: Envelope): string {
  return createHash('sha256').update(JSON.stringify({ k: env.kind, r: env.requestId, p: env.payload })).digest('hex');
}

function peekIds(raw: unknown): { messageId: string | null; requestId: string | null } {
  const r = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  return { messageId: typeof r['messageId'] === 'string' ? r['messageId'] : null, requestId: typeof r['requestId'] === 'string' ? r['requestId'] : null };
}
