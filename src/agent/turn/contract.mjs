const MUTATE_HINTS = [
  'update',
  'modify',
  'rewrite',
  'refactor',
  'add ',
  'remove',
  'delete',
  'rename',
  'change',
  'create file',
];

const EXTERNAL_HINTS = [
  'email',
  'calendar',
  'trello',
  'github',
  'jira',
  'notion',
];

function textFromEvent(event) {
  const content = event?.content;
  if (typeof content === 'string') {
    return content;
  }

  if (content && typeof content === 'object' && typeof content.text === 'string') {
    return content.text;
  }

  if (event?.type === 'workflow:step:start') {
    const instruction = content?.step?.instruction;
    return typeof instruction === 'string' ? instruction : '';
  }

  return '';
}

export function deriveTaskContract(event) {
  const text = textFromEvent(event).toLowerCase();
  const isExternal = EXTERNAL_HINTS.some((hint) => text.includes(hint));
  const isMutate = MUTATE_HINTS.some((hint) => text.includes(hint));

  const intent = isMutate ? 'mutate' : 'read';
  const scope = isExternal ? 'external' : 'local';
  const risk = intent === 'mutate' ? 'high' : 'low';
  const verifiers = ['non_empty'];

  if (intent === 'mutate' && scope === 'local') {
    verifiers.push('diff_sanity');
  }

  if (scope === 'external') {
    verifiers.push('schema');
  }

  return {
    intent,
    scope,
    risk,
    verifiers,
  };
}

function verifyNonEmpty(finalText) {
  return typeof finalText === 'string' && finalText.trim().length > 0;
}

function verifyDiffSanity(toolResultHistory) {
  for (const entry of toolResultHistory) {
    if (!entry || entry.name !== 'write') {
      continue;
    }

    const result = entry.result ?? {};
    if (
      result.mode === 'overwrite'
      && result.existedBefore === true
      && result.isCodeFile === true
      && result.rewriteReasonProvided !== true
    ) {
      return false;
    }
  }

  return true;
}

function verifySchema(finalText) {
  return typeof finalText === 'string' && finalText.trim().length > 0;
}

export function verifyFinalResponse({
  finalText,
  contract,
  toolResultHistory = [],
}) {
  const checks = Array.isArray(contract?.verifiers) ? contract.verifiers : [];

  for (const check of checks) {
    if (check === 'non_empty' && !verifyNonEmpty(finalText)) {
      return {
        ok: false,
        failure: {
          reason: 'empty_final_response',
          retryable: true,
          nextAction: 'retry_with_explicit_non_empty_instruction',
        },
      };
    }

    if (check === 'diff_sanity' && !verifyDiffSanity(toolResultHistory)) {
      return {
        ok: false,
        failure: {
          reason: 'unsafe_overwrite_without_reason',
          retryable: true,
          nextAction: 'retry_with_patch_or_rewrite_reason',
        },
      };
    }

    if (check === 'schema' && !verifySchema(finalText)) {
      return {
        ok: false,
        failure: {
          reason: 'schema_verifier_failed',
          retryable: true,
          nextAction: 'retry_with_structured_payload',
        },
      };
    }
  }

  return { ok: true, failure: null };
}

export function buildFinalRetryPrompt(failureReason) {
  if (failureReason === 'empty_final_response') {
    return [
      'Your previous final response was empty.',
      'Respond with a non-empty final answer.',
      'Do not return tool JSON unless you must call a tool.',
    ].join('\n');
  }

  if (failureReason === 'unsafe_overwrite_without_reason') {
    return [
      'Your previous response implied an unsafe file rewrite.',
      'Use minimal targeted edits.',
      'If rewrite is required, explicitly provide rewriteReason in write arguments.',
    ].join('\n');
  }

  return [
    'Your previous response failed final verification.',
    'Return a valid, non-empty final answer.',
  ].join('\n');
}
