import { AsyncLocalStorage } from 'node:async_hooks';
import axios, { type AxiosResponse, type InternalAxiosRequestConfig } from 'axios';
import { createLarkChannel, type LarkChannel, type NormalizedMessage, type CardActionEvent, type MarkdownStreamController } from '@larksuite/channel';
import type { StoredImConfig } from './settings';
import { replyCard } from './cards';

export interface Delivery { valid(): boolean; failed: boolean; abort: AbortController }
export interface ImChannel {
  connect(): Promise<void>;
  close(): Promise<void>;
  send(to: string, text: string): Promise<void>;
  stream(to: string, producer: (controller: MarkdownStreamController) => Promise<void>, delivery: Delivery): Promise<string>;
  /**
   * Publishes the final card through the public cardkit entity API (`channel.updateCardById`),
   * resolved from the ids this delivery actually created over HTTP — never from caller-supplied ids.
   */
  updateCard(messageId: string, card: object, delivery: Delivery): Promise<void>;
  /**
   * Best-effort terminal cleanup for one already-cancelled delivery: a bounded, restricted
   * entity update that pins the newest card this delivery created to `已停止。` with no buttons.
   * Never runs under a dead generation, never reports connection errors, never resumes content.
   */
  retireCard(delivery: Delivery, valid?: () => boolean): Promise<void>;
  state(): string;
}
export interface ImChannelHandlers { message(message: NormalizedMessage): void; card(event: CardActionEvent): Record<string, unknown>; menu(event: unknown): void; error(): void; connecting(): void; connected(): void }
export type ImChannelFactory = (config: StoredImConfig, handlers: ImChannelHandlers) => ImChannel;
/** Per-generation HTTP cancellation and per-stream delivery observations include SDK swallowed timer failures. */
export interface ImChannelInternals { createChannel?: typeof createLarkChannel }

/**
 * Per-delivery HTTP metadata observed from the shared axios interceptors: card ids bound to the
 * real message ids they were sent as, and every sequence the delivery initiated for each card.
 * Instants are recorded when a request passes the cancellation fence — requests whose outcome is
 * still unknown count, so the final update's sequence is strictly greater than all prior attempts.
 * Only these four bounded fields are read from requests/responses; nothing is ever logged.
 */
interface ObservedCard { cardId: string; created: boolean; messageId?: string; maxSequence: number }
interface DeliveryObservation { cards: ObservedCard[] }
type ManagedDelivery = Delivery & { readonly managed: true };

/** Annotates expected local cancellation (stop/new_session/generation close) for the SDK logger. */
class ChannelRequestError extends Error { constructor(readonly expectedCancellation: boolean) { super('IM_CHANNEL_REQUEST_FAILED'); } }

const CARDKIT_CARDS = '/open-apis/cardkit/v1/cards';
const CARD_CREATE = new RegExp(`${CARDKIT_CARDS}/?$`);
const CARD_CONTENT = /\/open-apis\/cardkit\/v1\/cards\/([^/]+)\/elements\/[^/]+\/content$/;
const CARD_SETTINGS = /\/open-apis\/cardkit\/v1\/cards\/([^/]+)\/settings$/;
const CARD_UPDATE = /\/open-apis\/cardkit\/v1\/cards\/([^/]+)\/?$/;
const IM_MESSAGES = /\/open-apis\/im\/v1\/messages(?:\/[^/]+\/reply)?$/;

const pathOnly = (url: string): string => { try { return new URL(url, 'https://weaver.invalid').pathname; } catch { return url.split('?')[0]!; } };
const envelopeData = (body: unknown): Record<string, unknown> | undefined => {
  if (!body || typeof body !== 'object') return undefined;
  const data = (body as { data?: unknown }).data;
  return data && typeof data === 'object' ? data as Record<string, unknown> : undefined;
};
const requestData = (data: unknown): Record<string, unknown> | undefined => {
  if (typeof data === 'string') { try { return JSON.parse(data); } catch { return undefined; } }
  return data && typeof data === 'object' ? data as Record<string, unknown> : undefined;
};
const sequenceOf = (data: unknown): number | undefined => {
  data = requestData(data);
  if (!data || typeof data !== 'object') return undefined;
  const sequence = (data as { sequence?: unknown }).sequence;
  return typeof sequence === 'number' && Number.isFinite(sequence) ? sequence : undefined;
};

export const createImChannel: ImChannelFactory = (config, handlers) => createImChannelTransport(config, handlers);
export function createImChannelTransport(config: StoredImConfig, handlers: ImChannelHandlers, internals: ImChannelInternals = {}): ImChannel {
  const generation = new AbortController();
  const deliveries = new AsyncLocalStorage<Delivery>();
  const observations = new WeakMap<Delivery, DeliveryObservation>();
  const expectedCancellation = (delivery: Delivery | undefined): boolean =>
    generation.signal.aborted || Boolean(delivery?.abort.signal.aborted && !delivery.failed);
  const http = axios.create({ timeout: 10_000 });
  http.interceptors.request.use(request => {
    const delivery = deliveries.getStore();
    if (generation.signal.aborted || (delivery && (!delivery.valid() || delivery.abort.signal.aborted))) throw new ChannelRequestError(true);
    request.timeout = 10_000;
    request.signal = delivery ? AbortSignal.any([generation.signal, delivery.abort.signal]) : generation.signal;
    // Record an initiated sequence only after the fence passed: fenced attempts never reached the platform.
    if (delivery) observeRequest(delivery, request);
    return request;
  });
  http.interceptors.response.use((response: AxiosResponse) => {
    const delivery = deliveries.getStore();
    const body = response.data;
    if (!body || typeof body !== 'object' || body.code !== 0) {
      // A received nonzero business code is a real platform failure, even if stop raced it.
      if (delivery) { delivery.failed = true; delivery.abort.abort(); }
      handlers.error(); throw new ChannelRequestError(false);
    }
    if (delivery) observeResponse(delivery, response);
    return body;
  }, error => {
    if (error instanceof ChannelRequestError && error.expectedCancellation) throw error;
    const delivery = deliveries.getStore();
    if (expectedCancellation(delivery) && axios.isCancel(error)) throw new ChannelRequestError(true);
    if (delivery) { delivery.failed = true; delivery.abort.abort(); }
    handlers.error();
    throw new ChannelRequestError(false);
  });
  // Never pass raw SDK arguments to any logger; they can contain secrets, tokens and message bodies.
  const noop = () => {};
  const channel: LarkChannel = (internals.createChannel ?? createLarkChannel)({ appId: config.appId, appSecret: config.appSecret,
    httpInstance: http as unknown as NonNullable<Parameters<typeof createLarkChannel>[0]['httpInstance']>,
    logger: { error: (...args: unknown[]) => {
      // node-sdk LoggerProxy wraps all arguments in an array; formatErrors adds another array.
      const marked = (value: unknown): boolean => Array.isArray(value) ? value.some(marked) : value instanceof ChannelRequestError && value.expectedCancellation;
      if (!expectedCancellation(deliveries.getStore()) && !args.some(marked)) handlers.error();
    }, warn: noop, info: noop, debug: noop, trace: noop },
    includeRawEvent: true, connectTimeoutMs: 15_000, handshakeTimeoutMs: 10_000,
    safety: { chatQueue: { enabled: false }, batch: { text: { delayMs: 0 } } },
    outbound: { streamMaxElementChars: 30_000, streamThrottleMs: 100, streamThrottleChars: 100 },
  });
  channel.on('message', handlers.message);
  channel.on('cardAction', handlers.card);
  channel.onRawEvent('application.bot.menu_v6', handlers.menu);
  channel.on('error', () => { if (!expectedCancellation(deliveries.getStore())) handlers.error(); });
  channel.on('reconnecting', handlers.connecting);
  channel.on('reconnected', handlers.connected);
  let connecting: Promise<void> | undefined;
  const observation = (delivery: Delivery): DeliveryObservation | undefined => observations.get(delivery);
  function observeRequest(delivery: Delivery, request: InternalAxiosRequestConfig): void {
    const observed = observation(delivery)?.cards;
    if (!observed?.length) return;
    const url = pathOnly(String(request.url ?? ''));
    const match = CARD_CONTENT.exec(url) ?? CARD_SETTINGS.exec(url) ?? CARD_UPDATE.exec(url);
    const entry = match ? observed.find(observedCard => observedCard.cardId === match[1]) : undefined;
    const sequence = entry ? sequenceOf(request.data) : undefined;
    if (entry && sequence !== undefined && sequence > entry.maxSequence) entry.maxSequence = sequence;
  }
  function observeResponse(delivery: Delivery, response: AxiosResponse): void {
    const observed = observation(delivery)?.cards;
    if (!observed) return;
    const url = pathOnly(String(response.config?.url ?? ''));
    const data = envelopeData(response.data);
    if (!data) return;
    if (CARD_CREATE.test(url)) {
      const cardId = data.card_id;
      if (typeof cardId === 'string' && cardId.length > 0 && cardId.length <= 256 && observed.length === 0) observed.push({ cardId, created: true, maxSequence: 0 });
    } else if (IM_MESSAGES.test(url)) {
      const sent = requestData(response.config?.data);
      const content = requestData(sent?.content);
      const cardId = requestData(content?.data)?.card_id;
      const messageId = data.message_id;
      const entry = observed.find(card => card.cardId === cardId && card.created);
      if (sent?.msg_type === 'interactive' && content?.type === 'card' && entry && typeof messageId === 'string' && messageId) entry.messageId = messageId;
    }
  }
  return {
    connect() { connecting = channel.connect().then(() => { if (generation.signal.aborted) channel.rawWsClient?.close({ force: true }); }); return connecting; },
    async close() {
      generation.abort();
      channel.rawWsClient?.close({ force: true });
      // disconnect() is a no-op while SDK connect is pending. Observe late completion then close again.
      await connecting?.catch(() => {});
      channel.rawWsClient?.close({ force: true });
      await channel.disconnect();
      channel.rawWsClient?.close({ force: true });
    },
    async send(to, text) { await channel.send(to, { text }); },
    async stream(to, producer, delivery) {
      if (!observations.has(delivery)) observations.set(delivery, { cards: [] });
      return await deliveries.run(delivery, async () => {
        const result = await channel.stream(to, { markdown: producer });
        if (delivery.failed || !delivery.valid()) throw new Error('IM_DELIVERY_FAILED');
        return result.messageId;
      });
    },
    async updateCard(messageId, card, delivery) {
      await deliveries.run(delivery, async () => {
        const observed = observation(delivery)?.cards;
        // Bind only to the card this delivery actually created and sent as that message over HTTP.
        const entry = observed?.find(observedCard => observedCard.messageId === messageId && observedCard.created);
        if (!entry) throw new Error('IM_CARD_BINDING_MISSING');
        await channel.updateCardById(entry.cardId, card, entry.maxSequence + 1);
      });
      if (delivery.failed || !delivery.valid()) throw new Error('IM_DELIVERY_FAILED');
    },
    async retireCard(done: Delivery, valid = () => true): Promise<void> {
      const observed = observation(done);
      // Only one already-sent, locally created card is eligible. Never allocate/send a new message.
      if (generation.signal.aborted || !valid() || observed?.cards.length !== 1) return;
      const latest = observed.cards[0]!;
      if (!latest.created || !latest.messageId) return;
      const managed: ManagedDelivery = { valid, failed: false, abort: new AbortController(), managed: true };
      observations.set(managed, observed);
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const update = deliveries.run(managed, () => channel.updateCardById(latest.cardId, replyCard('已停止。'), latest.maxSequence + 1));
        await Promise.race([update, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => { managed.abort.abort(); reject(new ChannelRequestError(true)); }, 5_000); })]);
      } catch { /* bounded best effort; actual HTTP failures were observed, with no Agent retry. */ }
      finally { clearTimeout(timer); managed.abort.abort(); }
    },
    state: () => channel.rawWsClient?.getConnectionStatus().state ?? 'idle',
  };
}
