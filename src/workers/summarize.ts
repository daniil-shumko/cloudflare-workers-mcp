/**
 * Pure response summarizers — reduce full API responses to the fields an
 * agent actually needs, keeping tool output small and stable.
 */

import type { WorkerScript } from "./types.js";

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
