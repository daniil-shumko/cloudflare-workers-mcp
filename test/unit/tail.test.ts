/**
 * Unit tests for the bounded live-tail collector (fake WebSocket) and the
 * tail event summarizer.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { collectTail, type TailSocket } from "../../src/workers/tail.js";
import { summarizeTailEvent } from "../../src/workers/summarize.js";
import type { TailEvent } from "../../src/workers/types.js";

/** A controllable stand-in for the WHATWG WebSocket. */
class FakeSocket implements TailSocket {
  protocol = "trace-v1";
  onopen: TailSocket["onopen"] = null;
  onmessage: TailSocket["onmessage"] = null;
  onerror: TailSocket["onerror"] = null;
  onclose: TailSocket["onclose"] = null;
  sent: string[] = [];
  closed = false;
  constructor(
    readonly url: string,
    readonly requestedProtocol: string
  ) {}
  send(data: string) {
    this.sent.push(data);
  }
  close() {
    this.closed = true;
  }
  open() {
    this.onopen?.({});
  }
  emit(event: unknown, binary = false) {
    const text = JSON.stringify(event);
    this.onmessage?.({ data: binary ? new TextEncoder().encode(text).buffer : text });
  }
}

function harness() {
  let socket!: FakeSocket;
  const socketFactory = (url: string, protocol: string) => (socket = new FakeSocket(url, protocol));
  return {
    socketFactory,
    get socket() {
      return socket;
    },
  };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));
const okEvent: TailEvent = { outcome: "ok", logs: [{ message: ["hello"], level: "log" }], exceptions: [] };
const errEvent: TailEvent = {
  outcome: "exception",
  logs: [],
  exceptions: [{ name: "Error", message: "kaboom" }],
};

test("collectTail subscribes with trace-v1, collects events, stops at max_events and closes", async () => {
  const h = harness();
  const done = collectTail({ url: "wss://t", durationMs: 60000, maxEvents: 2, socketFactory: h.socketFactory });
  assert.equal(h.socket.requestedProtocol, "trace-v1");
  h.socket.open();
  assert.deepEqual(h.socket.sent, [JSON.stringify({ debug: false })]);
  h.socket.emit(okEvent);
  h.socket.emit(errEvent, true); // binary frames are decoded too
  const result = await done;
  assert.equal(result.stopReason, "max_events");
  assert.equal(result.events.length, 2);
  assert.equal(h.socket.closed, true, "socket must be closed when collection ends");
});

test("collectTail ends after the duration window and still closes the socket", async () => {
  const h = harness();
  const done = collectTail({ url: "wss://t", durationMs: 20, maxEvents: 50, socketFactory: h.socketFactory });
  h.socket.open();
  h.socket.emit(okEvent);
  const result = await done;
  assert.equal(result.stopReason, "duration");
  assert.equal(result.events.length, 1);
  assert.equal(h.socket.closed, true);
});

test("collectTail filters client-side by errorsOnly and search", async () => {
  const h = harness();
  const done = collectTail({
    url: "wss://t",
    durationMs: 30,
    maxEvents: 50,
    errorsOnly: true,
    search: "KABOOM",
    socketFactory: h.socketFactory,
  });
  h.socket.open();
  h.socket.emit(okEvent);
  h.socket.emit(errEvent);
  h.socket.emit({ ...errEvent, exceptions: [{ name: "TypeError", message: "other" }] });
  await tick();
  const result = await done;
  assert.equal(result.events.length, 1);
  assert.equal(result.filtered, 2);
});

test("collectTail resolves with what it has when aborted, and calls onOpen once connected", async () => {
  const h = harness();
  const controller = new AbortController();
  let opened = 0;
  const done = collectTail({
    url: "wss://t",
    durationMs: 60000,
    maxEvents: 50,
    signal: controller.signal,
    onOpen: () => opened++,
    socketFactory: h.socketFactory,
  });
  h.socket.open();
  h.socket.emit(okEvent);
  await tick();
  controller.abort();
  const result = await done;
  assert.equal(opened, 1);
  assert.equal(result.stopReason, "aborted");
  assert.equal(result.events.length, 1);
  assert.equal(h.socket.closed, true);
});

test("collectTail rejects when the socket never opens", async () => {
  const h = harness();
  const done = collectTail({
    url: "wss://t",
    durationMs: 1000,
    maxEvents: 5,
    openTimeoutMs: 10,
    socketFactory: h.socketFactory,
  });
  await assert.rejects(done, /did not open/);
  assert.equal(h.socket.closed, true);
});

test("collectTail rejects on an error before open, and finishes on a remote close after open", async () => {
  const before = harness();
  const failed = collectTail({ url: "wss://t", durationMs: 1000, maxEvents: 5, socketFactory: before.socketFactory });
  before.socket.onerror?.({});
  await assert.rejects(failed, /failed to connect/);

  const after = harness();
  const closed = collectTail({ url: "wss://t", durationMs: 60000, maxEvents: 5, socketFactory: after.socketFactory });
  after.socket.open();
  after.socket.onclose?.({ code: 1006 });
  assert.equal((await closed).stopReason, "closed");
});

test("summarizeTailEvent renders the request line, logs and exceptions and drops headers", () => {
  const summary = summarizeTailEvent({
    outcome: "exception",
    eventTimestamp: Date.UTC(2026, 10, 5, 12, 0, 0),
    cpuTime: 2,
    wallTime: 5,
    scriptVersion: { id: "v-1" },
    logs: [
      { message: ["hello", { a: 1 }], level: "warn" },
      { message: ["plain"], level: "log" },
    ],
    exceptions: [{ name: "Error", message: "kaboom", stack: "at x" }],
    event: {
      request: { url: "https://w.example.dev/path?q=1", method: "POST", headers: { cookie: "secret" } },
      response: { status: 500 },
    },
  });
  assert.deepEqual(summary, {
    timestamp: "2026-11-05T12:00:00.000Z",
    outcome: "exception",
    request: "POST /path?q=1",
    status: 500,
    logs: ['[warn] hello {"a":1}', "[log] plain"],
    exceptions: ["Error: kaboom"],
    cpu_ms: 2,
    wall_ms: 5,
    version_id: "v-1",
  });
  assert.ok(!JSON.stringify(summary).includes("secret"), "request headers must never be included");
});

test("summarizeTailEvent labels scheduled events by cron", () => {
  assert.deepEqual(summarizeTailEvent({ outcome: "ok", event: { cron: "*/5 * * * *" } }), {
    outcome: "ok",
    request: "cron */5 * * * *",
  });
});
