const VALID_ID_PATTERN = /^[a-z0-9-]+$/;

const ALLOWED_WORKFLOW_FIELDS = new Set([
  'id', 'version', 'name', 'description', 'inputs', 'steps',
]);

const ALLOWED_STEP_FIELDS = new Set([
  'id', 'name', 'instruction', 'tools', 'loadSkills', 'dependsOn',
  'doneWhen', 'outputs', 'onFail', 'retries',
  'type', 'path', 'content', 'mode',
]);
const ALLOWED_STEP_TYPES = new Set([
  'agent',
  'system_write_file',
  'system_delete_file',
  'system_ensure_file',
]);

const ALLOWED_INPUT_FIELDS = new Set(['name', 'type', 'required', 'default']);
const ALLOWED_INPUT_TYPES = new Set(['string', 'number', 'boolean']);
const ALLOWED_ON_FAIL = new Set(['fail_run', 'blocked']);

function normalizeText(value) {
  if (typeof value !== 'string') return '';
  return value.trim();
}

function rejectUnknownFields(obj, allowed, label) {
  const errors = [];
  for (const key of Object.keys(obj)) {
    if (!allowed.has(key)) {
      errors.push(`${label}: unknown field '${key}'.`);
    }
  }
  return errors;
}

function validateInputs(rawInputs) {
  const errors = [];
  const normalized = [];

  if (!Array.isArray(rawInputs)) return { errors, normalized };

  for (let i = 0; i < rawInputs.length; i++) {
    const raw = rawInputs[i];
    if (!raw || typeof raw !== 'object') {
      errors.push(`inputs[${i}]: must be an object.`);
      continue;
    }

    errors.push(...rejectUnknownFields(raw, ALLOWED_INPUT_FIELDS, `inputs[${i}]`));

    const name = normalizeText(raw.name);
    if (!name) {
      errors.push(`inputs[${i}]: name is required.`);
      continue;
    }

    const type = normalizeText(raw.type) || 'string';
    if (!ALLOWED_INPUT_TYPES.has(type)) {
      errors.push(`inputs[${i}]: invalid type '${type}'.`);
    }

    normalized.push({
      name,
      type,
      required: raw.required !== false,
      ...(raw.default !== undefined ? { default: raw.default } : {}),
    });
  }

  return { errors, normalized };
}

function detectCycle(steps) {
  const ids = new Set(steps.map((s) => s.id));
  const visited = new Set();
  const inStack = new Set();

  const adjacency = new Map();
  for (const step of steps) {
    adjacency.set(step.id, step.dependsOn);
  }

  function visit(id) {
    if (inStack.has(id)) return true;
    if (visited.has(id)) return false;

    visited.add(id);
    inStack.add(id);

    for (const dep of adjacency.get(id) ?? []) {
      if (ids.has(dep) && visit(dep)) return true;
    }

    inStack.delete(id);
    return false;
  }

  for (const id of ids) {
    if (visit(id)) return true;
  }

  return false;
}

export function validateWorkflow(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { valid: false, errors: ['workflow must be a plain object.'], workflow: null };
  }

  const errors = [];

  errors.push(...rejectUnknownFields(raw, ALLOWED_WORKFLOW_FIELDS, 'workflow'));

  const id = normalizeText(raw.id);
  if (!id) {
    errors.push('id is required and must be non-empty.');
  } else if (!VALID_ID_PATTERN.test(id)) {
    errors.push(`id '${id}' must match ${VALID_ID_PATTERN}.`);
  }

  const version = normalizeText(raw.version);
  if (!version) {
    errors.push('version is required and must be non-empty.');
  }

  const name = normalizeText(raw.name) || id || '';
  const description = normalizeText(raw.description);

  const { errors: inputErrors, normalized: normalizedInputs } = validateInputs(raw.inputs);
  errors.push(...inputErrors);

  const stepsInput = Array.isArray(raw.steps) ? raw.steps : null;
  if (!stepsInput || stepsInput.length === 0) {
    errors.push('steps must be a non-empty array.');
    return { valid: false, errors, workflow: null };
  }

  const normalizedSteps = [];
  const seenIds = new Set();

  for (let i = 0; i < stepsInput.length; i++) {
    const rawStep = stepsInput[i];
    if (!rawStep || typeof rawStep !== 'object') {
      errors.push(`steps[${i}]: must be an object.`);
      continue;
    }

    const stepErrors = rejectUnknownFields(rawStep, ALLOWED_STEP_FIELDS, `steps[${i}]`);

    const stepId = normalizeText(String(rawStep.id ?? ''));
    if (!stepId) {
      stepErrors.push('id is required.');
    } else if (seenIds.has(stepId)) {
      stepErrors.push(`duplicate step id '${stepId}'.`);
    }

    const type = normalizeText(rawStep.type || 'agent') || 'agent';
    if (!ALLOWED_STEP_TYPES.has(type)) {
      stepErrors.push(`invalid step type '${type}'.`);
    }

    const instruction = normalizeText(rawStep.instruction ?? '');

    const tools = Array.isArray(rawStep.tools)
      ? rawStep.tools.map((t) => normalizeText(String(t))).filter((t) => t.length > 0)
      : [];

    if (type === 'agent') {
      if (!instruction) {
        stepErrors.push('instruction is required.');
      }
      if (tools.length === 0) {
        stepErrors.push('tools must be a non-empty array.');
      }
    }

    const stepPath = normalizeText(rawStep.path ?? '');
    if (type !== 'agent' && !stepPath) {
      stepErrors.push('path is required for system steps.');
    }

    const content = rawStep.content != null ? String(rawStep.content) : '';
    const mode = rawStep.mode != null ? normalizeText(String(rawStep.mode)) : null;
    if (type === 'system_write_file' && !content) {
      stepErrors.push('content is required for system_write_file steps.');
    }

    const loadSkills = Array.isArray(rawStep.loadSkills)
      ? rawStep.loadSkills.map((s) => normalizeText(String(s))).filter((s) => s.length > 0)
      : [];

    const dependsOn = Array.isArray(rawStep.dependsOn)
      ? rawStep.dependsOn.map((d) => normalizeText(String(d))).filter((d) => d.length > 0)
      : [];

    const outputs = Array.isArray(rawStep.outputs)
      ? rawStep.outputs.map((entry) => normalizeText(String(entry))).filter((entry) => entry.length > 0)
      : [];
    if (type !== 'system_delete_file' && outputs.length === 0) {
      stepErrors.push('outputs must be a non-empty array for this step type.');
    }
    if (type === 'system_delete_file' && outputs.length > 0) {
      stepErrors.push('outputs must be empty for system_delete_file steps.');
    }

    const doneWhen = Array.isArray(rawStep.doneWhen) ? rawStep.doneWhen : [];
    if (doneWhen.length === 0) {
      stepErrors.push('doneWhen must be a non-empty array.');
    }
    for (let j = 0; j < doneWhen.length; j++) {
      if (!doneWhen[j] || typeof doneWhen[j] !== 'object' || !doneWhen[j].type) {
        stepErrors.push(`doneWhen[${j}] must have a type field.`);
      }
    }

    const onFail = normalizeText(String(rawStep.onFail ?? 'fail_run')) || 'fail_run';
    if (!ALLOWED_ON_FAIL.has(onFail)) {
      stepErrors.push(`onFail must be one of: ${[...ALLOWED_ON_FAIL].join(', ')}.`);
    }

    const retries = rawStep.retries != null ? Number(rawStep.retries) : 0;
    if (!Number.isInteger(retries) || retries < 0) {
      stepErrors.push('retries must be a non-negative integer.');
    }

    const stepName = normalizeText(rawStep.name ?? '') || stepId;

    if (stepErrors.length > 0) {
      errors.push(`step '${stepId || i}': ${stepErrors.join(' ')}`);
    } else {
      normalizedSteps.push({
        id: stepId,
        name: stepName,
        type,
        instruction,
        tools,
        loadSkills,
        dependsOn,
        doneWhen,
        outputs,
        onFail,
        retries,
        path: stepPath || null,
        content: content || null,
        mode,
      });
      seenIds.add(stepId);
    }
  }

  if (normalizedSteps.length === 0 && errors.length > 0) {
    return { valid: false, errors, workflow: null };
  }

  for (const step of normalizedSteps) {
    for (const dep of step.dependsOn) {
      if (!seenIds.has(dep)) {
        errors.push(`step '${step.id}' depends on unknown step '${dep}'.`);
      }
    }
  }

  if (detectCycle(normalizedSteps)) {
    errors.push('steps contain a dependency cycle.');
  }

  if (errors.length > 0) {
    return { valid: false, errors, workflow: null };
  }

  return {
    valid: true,
    errors: [],
    workflow: {
      id,
      version,
      name,
      description,
      inputs: normalizedInputs,
      steps: normalizedSteps,
    },
  };
}
