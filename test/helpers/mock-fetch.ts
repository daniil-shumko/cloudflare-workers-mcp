/**
 * A tiny global-fetch stub for unit-testing WorkersClient without network I/O.
 *
 * The client calls `fetch(url, init)` then reads `response.text()`. This helper
 * swaps `globalThis.fetch` for a queue-driven fake: each call dequeues the next
 * canned response and records what the client sent (url, method, headers, body),
 * so tests can assert both the request shape and the parsed result.
 */

export interface RecordedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  /** Raw body as passed to fetch: a JSON string, a FormData, or undefined. */
  body: unknown;
}

export interface CannedResponse {
  /** HTTP status (default 200). `ok` is derived as 2xx unless set, matching real Response.ok. */
  status?: number;
  ok?: boolean;
  statusText?: string;
  /** Object serialized to the response body. Mutually exclusive with `text`. */
  json?: unknown;
  /** Raw response body text (use for non-JSON / edge-HTML cases). */
  text?: string;
}

export interface MockFetch {
  calls: RecordedCall[];
  /** Queue one response to be returned by the next fetch() call. */
  enqueue(res: CannedResponse): void;
  /** Make the next fetch() reject with the given error (network/abort). */
  enqueueError(err: Error): void;
  restore(): void;
}

type QueueItem = { kind: "response"; res: CannedResponse } | { kind: "error"; err: Error };

export function installMockFetch(): MockFetch {
  const original = globalThis.fetch;
  const queue: QueueItem[] = [];
  const calls: RecordedCall[] = [];

  const fake = (async (input: unknown, init?: Record<string, unknown>) => {
    const url = typeof input === "string" ? input : String((input as { url?: string })?.url ?? input);
    const headers = (init?.headers as Record<string, string>) ?? {};
    calls.push({
      url,
      method: (init?.method as string) ?? "GET",
      headers,
      body: init?.body,
    });

    const item = queue.shift();
    if (!item) throw new Error(`mock fetch: no queued response for ${url}`);
    if (item.kind === "error") throw item.err;

    const { status = 200, ok, statusText = "", json, text } = item.res;
    const bodyText = text !== undefined ? text : json !== undefined ? JSON.stringify(json) : "";
    return {
      ok: ok ?? (status >= 200 && status < 300),
      status,
      statusText,
      text: async () => bodyText,
      json: async () => JSON.parse(bodyText),
    } as Response;
  }) as typeof fetch;

  globalThis.fetch = fake;

  return {
    calls,
    enqueue: (res) => queue.push({ kind: "response", res }),
    enqueueError: (err) => queue.push({ kind: "error", err }),
    restore: () => { globalThis.fetch = original; },
  };
}

/** Build a Cloudflare success envelope around a result. */
export function cfOk<T>(result: T): CannedResponse {
  return { status: 200, json: { success: true, errors: [], messages: [], result } };
}

/** Build a Cloudflare error envelope (HTTP `status`, CF error `code`). */
export function cfErr(status: number, code: number, message: string): CannedResponse {
  return { status, json: { success: false, errors: [{ code, message }], messages: [], result: null } };
}
