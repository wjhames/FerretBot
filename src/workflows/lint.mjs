export function lintWorkflow(workflow, options = {}) {
  const knownCheckTypes = new Set(options.knownCheckTypes ?? []);
  const errors = [];
  const warnings = [];
  const id = workflow?.id ?? 'unknown-workflow';
  const steps = Array.isArray(workflow?.steps) ? workflow.steps : [];

  for (const step of steps) {
    const stepId = step?.id ?? 'unknown-step';
    const outputs = Array.isArray(step?.outputs) ? step.outputs : [];
    const doneWhen = Array.isArray(step?.doneWhen) ? step.doneWhen : [];

    if (outputs.length === 0 && step?.type !== 'system_delete_file') {
      errors.push(`[${id}:${stepId}] missing outputs.`);
    }
    if (doneWhen.length === 0) {
      errors.push(`[${id}:${stepId}] missing doneWhen checks.`);
    }

    const fileBackedChecks = new Set(
      doneWhen
        .map((check) => (check && typeof check.path === 'string' ? check.path : null))
        .filter(Boolean),
    );

    for (const output of outputs) {
      if (!fileBackedChecks.has(output)) {
        warnings.push(`[${id}:${stepId}] output '${output}' has no file-backed doneWhen check.`);
      }
    }

    for (const check of doneWhen) {
      const type = String(check?.type ?? '');
      if (!knownCheckTypes.has(type)) {
        errors.push(`[${id}:${stepId}] unknown check type '${type}'.`);
      }
      if (type === 'contains' || type === 'not_contains' || type === 'regex') {
        warnings.push(`[${id}:${stepId}] check '${type}' depends on model text output; prefer file-based checks.`);
      }
    }
  }

  return {
    workflowId: id,
    ok: errors.length === 0,
    errors,
    warnings,
  };
}
