/** Explicit main-agent workflow stages. The bridge records stages; it never auto-advances them. */
export const WORKFLOW_STAGES = Object.freeze(['plan', 'implement', 'exec', 'review']);

const MODE_STAGES = Object.freeze({
  plan: 'plan',
  implement: 'implement',
  review: 'review',
});

export function stageForMode(mode) {
  return MODE_STAGES[mode] ?? null;
}

export function resolveWorkflowStage(value, mode, operation = '') {
  const defaultStage = mode === 'exec' ? 'exec' : stageForMode(mode);
  const requested = value === undefined || value === null || String(value).trim() === '' ? defaultStage : String(value).trim();
  if (!requested) return { stage: null, error: null };
  if (!WORKFLOW_STAGES.includes(requested)) return { stage: null, error: `stage must be one of ${WORKFLOW_STAGES.join(', ')}` };
  if (requested === 'exec' && mode !== 'exec') return { stage: null, error: 'stage=exec is reserved for reasonix_exec' };
  if (mode !== 'exec' && stageForMode(mode) !== requested) return { stage: null, error: `mode=${mode} only supports stage=${stageForMode(mode)}` };
  if (mode === 'exec' && requested !== 'exec') return { stage: null, error: `operation=${operation || 'exec'} only supports stage=exec` };
  return { stage: requested, error: null };
}

export function workflowStatus(jobs = [], lastRun = null) {
  const activeStages = [...new Set(jobs.filter((job) => job?.state === 'running' && job.stage).map((job) => job.stage))];
  return {
    template: [...WORKFLOW_STAGES],
    activeStages,
    lastStage: lastRun?.stage ?? null,
  };
}
