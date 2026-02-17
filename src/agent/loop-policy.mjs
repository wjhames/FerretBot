const EMPTY_RESPONSE_TEXT = 'Model returned an empty response.';

export function shouldAttemptTextToolParse(text, finishReason) {
  if (finishReason === 'tool_calls') {
    return true;
  }

  if (typeof text !== 'string') {
    return false;
  }

  return text.trimStart().startsWith('{');
}

export function buildCorrectionPrompt(reason) {
  return [
    'Your previous response was invalid for tool execution.',
    `Reason: ${reason}`,
    'Respond with either:',
    '1) Exactly one JSON tool call object: {"tool":"name","args":{...}}',
    '2) Plain text final answer (no JSON).',
  ].join('\n');
}

export function buildContinuationPrompt() {
  return [
    'Continue exactly from where your previous response stopped.',
    'Do not repeat earlier text.',
    'Do not add preamble or explanation.',
  ].join('\n');
}

export function normalizeFinalText(text) {
  const normalized = typeof text === 'string' ? text.trim() : '';
  return normalized.length > 0 ? normalized : EMPTY_RESPONSE_TEXT;
}

export function shouldContinueCompletion(completion, continuationCount, maxContinuations) {
  if (continuationCount >= maxContinuations) {
    return false;
  }

  const reason = String(completion?.finishReason ?? '').toLowerCase();
  return reason === 'length' || reason === 'max_tokens';
}

export function parseCompletion(completion, parser) {
  if (!shouldAttemptTextToolParse(completion.text, completion.finishReason)) {
    return {
      kind: 'emit_final',
      text: completion.text,
    };
  }

  const parsed = parser.parse(completion.text);

  if (parsed.kind === 'parse_error') {
    return {
      kind: 'retry_parse',
      error: parsed.error,
    };
  }

  if (parsed.kind === 'final') {
    return {
      kind: 'emit_final',
      text: parsed.text,
    };
  }

  return {
    kind: 'tool_call',
    toolName: parsed.toolName,
    arguments: parsed.arguments,
  };
}

export function toToolCallFromNative(completion) {
  const nativeToolCall =
    Array.isArray(completion.toolCalls) && completion.toolCalls.length > 0
      ? completion.toolCalls[0]
      : null;

  if (!nativeToolCall) {
    return null;
  }

  return {
    toolName: nativeToolCall.name,
    arguments: nativeToolCall.arguments ?? {},
    toolCallId: nativeToolCall.id,
    rawAssistantText: completion.text,
  };
}

export function toToolCallFromParsed(parsed, completion) {
  return {
    toolName: parsed.toolName,
    arguments: parsed.arguments,
    toolCallId: null,
    rawAssistantText: completion.text,
  };
}
