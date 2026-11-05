/**
 * Live-tail collection over the classic trace-v1 WebSocket (the protocol
 * `wrangler tail` uses), bounded so it fits an MCP request/response tool:
 * collect events for a fixed window or until enough arrive, then close.
 *
 * Protocol facts verified live 2026-11-05: connect to the URL from
 * POST .../scripts/{name}/tails with subprotocol "trace-v1", send
 * `{"debug":false}`, and each message is one JSON event (text or binary
 * frame). Filtering here is client-side on purpose — the server-side filter
 * vocabulary is undocumented.
 */

import type { TailEvent } from "./types.js";

/** The subset of the WHATWG WebSocket this module needs (injectable for tests). */
export interface TailSocket {
  readonly protocol: string;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onerror: ((event: unknown) => void) | null;
  onclose: ((event: { code?: number; reason?: string }) => void) | null;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

export type TailSocketFactory = (url: string, protocol: string) => TailSocket;

export interface CollectTailOptions {
  url: string;
  /** How long to listen after the socket opens. */
  durationMs: number;
  /** Stop early once this many matching events were collected. */
  maxEvents: number;
  /** Keep only events that are not outcome "ok" or carry exceptions. */
  errorsOnly?: boolean;
  /** Case-insensitive substring matched against the event's logs, exceptions and URL. */
  search?: string;
  /** Abort (e.g. the MCP request was cancelled) — resolves with what was collected. */
  signal?: AbortSignal;
  /** Called once the socket is open and subscribed (e.g. to send a trigger request). */
  onOpen?: () => void;
  /** Max time to wait for the socket to open. */
  openTimeoutMs?: number;
  socketFactory?: TailSocketFactory;
}

export interface CollectTailResult {
  events: TailEvent[];
  /** Events received but filtered out by errorsOnly/search. */
  filtered: number;
  /** Why collection ended. */
  stopReason: "duration" | "max_events" | "aborted" | "closed";
}

const defaultFactory: TailSocketFactory = (url, protocol) =>
  new WebSocket(url, protocol) as unknown as TailSocket;

async function frameText(data: unknown): Promise<string> {
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  if (ArrayBuffer.isView(data)) {
    return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString("utf8");
  }
  if (data && typeof (data as Blob).text === "function") return (data as Blob).text();
  return String(data);
}

export function isErrorEvent(event: TailEvent): boolean {
  return (
    (event.outcome !== undefined && event.outcome !== "ok") || (event.exceptions?.length ?? 0) > 0
  );
}

function matchesSearch(event: TailEvent, needle: string): boolean {
  const haystack = [
    event.event?.request?.url ?? "",
    ...(event.logs ?? []).map((l) => (l.message ?? []).map(String).join(" ")),
    ...(event.exceptions ?? []).map((e) => `${e.name ?? ""} ${e.message ?? ""}`),
  ]
    .join("\n")
    .toLowerCase();
  return haystack.includes(needle.toLowerCase());
}

/**
 * Open the tail socket, collect events, and ALWAYS close the socket before
 * settling (window elapsed, enough events, abort, error or remote close).
 * Rejects only if the socket never opens.
 */
export function collectTail(options: CollectTailOptions): Promise<CollectTailResult> {
  const factory = options.socketFactory ?? defaultFactory;
  const openTimeoutMs = options.openTimeoutMs ?? 15000;

  return new Promise<CollectTailResult>((resolve, reject) => {
    const events: TailEvent[] = [];
    let filtered = 0;
    let opened = false;
    let settled = false;
    let openTimer: ReturnType<typeof setTimeout> | undefined;
    let windowTimer: ReturnType<typeof setTimeout> | undefined;

    if (options.signal?.aborted) {
      resolve({ events, filtered, stopReason: "aborted" });
      return;
    }

    const socket = factory(options.url, "trace-v1");

    const cleanup = () => {
      clearTimeout(openTimer);
      clearTimeout(windowTimer);
      options.signal?.removeEventListener("abort", onAbort);
      socket.onopen = socket.onmessage = socket.onerror = socket.onclose = null;
      try {
        socket.close(1000, "done");
      } catch {
        // Already closed.
      }
    };

    const finish = (stopReason: CollectTailResult["stopReason"]) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve({ events, filtered, stopReason });
    };

    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };

    function onAbort() {
      finish("aborted");
    }
    options.signal?.addEventListener("abort", onAbort, { once: true });

    openTimer = setTimeout(
      () => fail(new Error(`Tail WebSocket did not open within ${openTimeoutMs}ms`)),
      openTimeoutMs
    );

    socket.onopen = () => {
      opened = true;
      clearTimeout(openTimer);
      socket.send(JSON.stringify({ debug: false }));
      windowTimer = setTimeout(() => finish("duration"), options.durationMs);
      options.onOpen?.();
    };

    socket.onmessage = (message) => {
      void frameText(message.data).then((text) => {
        if (settled) return;
        let event: TailEvent;
        try {
          event = JSON.parse(text) as TailEvent;
        } catch {
          return; // Non-JSON frame — ignore.
        }
        if (
          (options.errorsOnly && !isErrorEvent(event)) ||
          (options.search && !matchesSearch(event, options.search))
        ) {
          filtered++;
          return;
        }
        events.push(event);
        if (events.length >= options.maxEvents) finish("max_events");
      });
    };

    socket.onerror = () => {
      if (!opened) fail(new Error("Tail WebSocket failed to connect"));
      else finish("closed");
    };

    socket.onclose = () => {
      if (!opened) fail(new Error("Tail WebSocket closed before opening"));
      else finish("closed");
    };
  });
}
