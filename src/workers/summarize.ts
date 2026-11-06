/**
 * Pure response summarizers — reduce full API responses to the fields an
 * agent actually needs, keeping tool output small and stable.
 */

import type {
  TailEvent,
  TelemetryEvent,
  WorkerDeployment,
  WorkerDomain,
  WorkerInfo,
  WorkerVersion,
} from "./types.js";

export interface WorkerSummary {
  name: string;
  created_on?: string;
  modified_on?: string;
  /** null when the Worker exists but has never been deployed. */
  deployed_on?: string | null;
  logpush?: boolean;
  /** Served on <name>.<account>.workers.dev */
  workers_dev?: boolean;
  observability?: boolean;
}

export function summarizeWorker(worker: WorkerInfo): WorkerSummary {
  return {
    name: worker.name,
    created_on: worker.created_on,
    modified_on: worker.updated_on,
    deployed_on: worker.deployed_on,
    logpush: worker.logpush,
    workers_dev: worker.subdomain?.enabled,
    observability: typeof worker.observability?.enabled === "boolean" ? (worker.observability.enabled as boolean) : undefined,
  };
}

export interface VersionSummary {
  id: string;
  number?: number;
  created_on?: string;
  author?: string;
  /** How the version was created: api | wrangler | terraform | dash | … */
  source?: string;
  /** The workers/message annotation (deploy message), when set. */
  message?: string;
  /** The workers/tag annotation, when set. */
  tag?: string;
}

export function summarizeVersion(version: WorkerVersion): VersionSummary {
  const summary: VersionSummary = {
    id: version.id,
    number: version.number,
    created_on: version.created_on,
    author: version.author_email,
    source: version.source,
    message: version.annotations?.["workers/message"],
    tag: version.annotations?.["workers/tag"],
  };
  return Object.fromEntries(Object.entries(summary).filter(([, v]) => v !== undefined)) as VersionSummary;
}

export interface DeploymentSummary {
  id: string;
  created_on?: string;
  source?: string;
  strategy?: string;
  author?: string;
  /** The "workers/message" annotation, when set. */
  message?: string;
  versions?: Array<{ version_id: string; percentage: number }>;
}

export function summarizeDeployment(deployment: WorkerDeployment): DeploymentSummary {
  const annotations = deployment.annotations ?? {};
  return {
    id: deployment.id,
    created_on: deployment.created_on,
    source: deployment.source,
    strategy: deployment.strategy,
    author: deployment.author_email,
    message: typeof annotations["workers/message"] === "string" ? (annotations["workers/message"] as string) : undefined,
    versions: deployment.versions,
  };
}

export interface DomainSummary {
  id: string;
  hostname?: string;
  zone_name?: string;
  service?: string;
  environment?: string;
}

export function summarizeDomain(domain: WorkerDomain): DomainSummary {
  return {
    id: domain.id,
    hostname: domain.hostname,
    zone_name: domain.zone_name,
    service: domain.service,
    environment: domain.environment,
  };
}

export interface LogEventSummary {
  timestamp?: string;
  level?: string;
  message?: string;
  error?: string;
  outcome?: string;
  event_type?: string;
  /** "GET /path" for fetch events, the cron expression for scheduled ones, etc. */
  request?: string;
  status?: number;
  cpu_ms?: number;
  wall_ms?: number;
}

export function summarizeLogEvent(event: TelemetryEvent): LogEventSummary {
  const meta = event.$metadata ?? {};
  const workers = event.$workers ?? {};
  const request = workers.event?.request;
  const summary: LogEventSummary = {
    timestamp: event.timestamp !== undefined ? new Date(event.timestamp).toISOString() : undefined,
    level: meta.level,
    message: meta.message,
    error: meta.error,
    outcome: workers.outcome,
    event_type: workers.eventType,
    request: request
      ? [request.method, request.path ?? request.url].filter(Boolean).join(" ") || undefined
      : meta.trigger,
    status: workers.event?.response?.status ?? meta.statusCode,
    cpu_ms: workers.cpuTimeMs,
    wall_ms: workers.wallTimeMs,
  };
  // Drop undefined keys so log lines stay compact.
  return Object.fromEntries(
    Object.entries(summary).filter(([, value]) => value !== undefined)
  ) as LogEventSummary;
}

export interface TailEventSummary {
  timestamp?: string;
  outcome?: string;
  /** "GET /path?query" for fetch events, "cron <expr>" for scheduled ones. */
  request?: string;
  status?: number;
  logs?: string[];
  exceptions?: string[];
  cpu_ms?: number;
  wall_ms?: number;
  version_id?: string;
  truncated?: boolean;
}

/** Render a log line's message parts the way console.log would join them. */
function renderLogMessage(parts: unknown[] | undefined): string {
  return (parts ?? [])
    .map((part) => (typeof part === "string" ? part : JSON.stringify(part)))
    .join(" ");
}

/**
 * Compact a trace-v1 tail event. Request headers and `cf` metadata are
 * deliberately dropped — they can carry cookies, auth headers and client IPs.
 */
export function summarizeTailEvent(event: TailEvent): TailEventSummary {
  const request = event.event?.request;
  let requestLine: string | undefined;
  if (request?.url) {
    let path = request.url;
    try {
      const parsed = new URL(request.url);
      path = parsed.pathname + parsed.search;
    } catch {
      // Not an absolute URL — keep it verbatim.
    }
    requestLine = [request.method, path].filter(Boolean).join(" ");
  } else if (typeof event.event?.cron === "string") {
    requestLine = `cron ${event.event.cron}`;
  }

  const summary: TailEventSummary = {
    timestamp:
      event.eventTimestamp !== undefined ? new Date(event.eventTimestamp).toISOString() : undefined,
    outcome: event.outcome,
    request: requestLine,
    status: event.event?.response?.status,
    logs: event.logs?.length
      ? event.logs.map((log) => `[${log.level ?? "log"}] ${renderLogMessage(log.message)}`)
      : undefined,
    exceptions: event.exceptions?.length
      ? event.exceptions.map((e) => `${e.name ?? "Error"}: ${e.message ?? ""}`.trim())
      : undefined,
    cpu_ms: event.cpuTime,
    wall_ms: event.wallTime,
    version_id: event.scriptVersion?.id,
    truncated: event.truncated || undefined,
  };
  return Object.fromEntries(
    Object.entries(summary).filter(([, value]) => value !== undefined)
  ) as TailEventSummary;
}
