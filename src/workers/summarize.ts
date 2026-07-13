/**
 * Pure response summarizers — reduce full API responses to the fields an
 * agent actually needs, keeping tool output small and stable.
 */

import type {
  WorkerDeployment,
  WorkerDomain,
  WorkerScript,
  WorkerVersion,
} from "./types.js";

export interface WorkerSummary {
  name: string;
  created_on?: string;
  modified_on?: string;
  has_assets?: boolean;
  has_modules?: boolean;
  usage_model?: string;
  placement_mode?: string;
  logpush?: boolean;
}

export function summarizeWorker(script: WorkerScript): WorkerSummary {
  return {
    name: script.id,
    created_on: script.created_on,
    modified_on: script.modified_on,
    has_assets: script.has_assets,
    has_modules: script.has_modules,
    usage_model: script.usage_model,
    placement_mode: script.placement_mode,
    logpush: script.logpush,
  };
}

export interface VersionSummary {
  id: string;
  number?: number;
  created_on?: string;
  author?: string;
  /** How the version was created: api | wrangler | terraform | dash | … */
  source?: string;
}

// Version annotations (workers/message etc.) are write-only on upload — the
// read endpoints never return them, so the summary doesn't carry them.
export function summarizeVersion(version: WorkerVersion): VersionSummary {
  return {
    id: version.id,
    number: version.number,
    created_on: version.metadata?.created_on,
    author: version.metadata?.author_email,
    source: version.metadata?.source,
  };
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
