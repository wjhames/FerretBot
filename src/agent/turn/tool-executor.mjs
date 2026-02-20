import { buildCorrectionPrompt } from './policy.mjs';

function validateToolPolicy(parsedToolCall) {
  if (!parsedToolCall || typeof parsedToolCall !== 'object') {
    return null;
  }

  if (parsedToolCall.toolName === 'bash') {
    const command = String(parsedToolCall.arguments?.command ?? '');
    if (/\bls\s+-R\b/.test(command)) {
      return 'Avoid recursive directory dumps (ls -R). Use targeted reads/listing.';
    }
  }

  return null;
}

export async function executeToolCall(options = {}) {
  const {
    event,
    messages,
    completion,
    parsedToolCall,
    toolCalls,
    toolCallHistory = [],
    toolResultHistory = [],
    correctionRetries,
    retryLimit,
    maxToolCallsPerStep,
    toolRegistry,
    toolExecutionContext = {},
    queueEmit,
    appendSessionTurn,
    emitCorrectionFailure,
  } = options;

  if (
    !toolRegistry
    || typeof toolRegistry.execute !== 'function'
  ) {
    throw new Error(
      'Tool call requested but no toolRegistry.execute is configured.',
    );
  }

  const validation =
    typeof toolRegistry.validateCall === 'function'
      ? toolRegistry.validateCall({
          name: parsedToolCall.toolName,
          arguments: parsedToolCall.arguments,
        })
      : { valid: true, errors: [] };
  const policyViolation = validateToolPolicy(parsedToolCall);
  if (policyViolation) {
    const existing = Array.isArray(validation.errors) ? validation.errors : [];
    validation.valid = false;
    validation.errors = [...existing, policyViolation];
  }

  if (!validation.valid) {
    const reason = validation.errors?.join(' ') || 'Invalid tool call.';
    const shouldRetry = correctionRetries < retryLimit;

    if (!shouldRetry) {
      emitCorrectionFailure(event, 'Unable to produce a valid tool call after retries.');
      return { done: true, toolCalls, correctionRetries };
    }

    const nextRetries = correctionRetries + 1;
    messages.push({
      role: 'assistant',
      content: parsedToolCall.rawAssistantText ?? completion.text,
    });
    messages.push({ role: 'system', content: buildCorrectionPrompt(reason) });
    queueEmit({
      type: 'agent:status',
      channel: event.channel,
      sessionId: event.sessionId,
      content: {
        phase: 'validate:retry',
        text: `Retrying invalid tool call (${nextRetries}/${retryLimit}).`,
        detail: reason,
      },
    });

    return {
      done: false,
      toolCalls,
      correctionRetries: nextRetries,
    };
  }

  const nextToolCalls = toolCalls + 1;
  if (nextToolCalls > maxToolCallsPerStep) {
    const requestId = typeof event?.content?.requestId === 'string' && event.content.requestId.trim().length > 0
      ? event.content.requestId.trim()
      : null;
    queueEmit({
      type: 'agent:response',
      channel: event.channel,
      sessionId: event.sessionId,
      content: {
        text: 'Tool call limit reached before final response.',
        finishReason: 'tool_limit',
        usage: completion.usage,
        requestId,
      },
    });
    return { done: true, toolCalls: nextToolCalls, correctionRetries: 0 };
  }

  queueEmit({
    type: 'agent:status',
    channel: event.channel,
    sessionId: event.sessionId,
    content: {
      phase: 'tool:start',
      text: `Running tool: ${parsedToolCall.toolName}`,
      tool: {
        name: parsedToolCall.toolName,
        arguments: parsedToolCall.arguments,
      },
    },
  });

  toolCallHistory.push({
    name: parsedToolCall.toolName,
    arguments: parsedToolCall.arguments,
    toolCallId: parsedToolCall.toolCallId ?? null,
  });

  let toolResult;
  try {
    toolResult = await toolRegistry.execute({
      name: parsedToolCall.toolName,
      arguments: parsedToolCall.arguments,
      event,
      context: toolExecutionContext,
    });
  } catch (error) {
    const reason = error?.message ?? String(error);
    const shouldRetry = correctionRetries < retryLimit;

    if (!shouldRetry) {
      emitCorrectionFailure(event, `Tool '${parsedToolCall.toolName}' failed: ${reason}`);
      return { done: true, toolCalls: nextToolCalls, correctionRetries };
    }

    const nextRetries = correctionRetries + 1;
    messages.push({
      role: 'assistant',
      content: parsedToolCall.rawAssistantText ?? completion.text,
    });
    messages.push({ role: 'system', content: buildCorrectionPrompt(`Tool '${parsedToolCall.toolName}' failed: ${reason}`) });
    queueEmit({
      type: 'agent:status',
      channel: event.channel,
      sessionId: event.sessionId,
      content: {
        phase: 'tool:retry',
        text: `Retrying failed tool call (${nextRetries}/${retryLimit}).`,
        detail: reason,
        tool: {
          name: parsedToolCall.toolName,
        },
      },
    });

    return {
      done: false,
      toolCalls: nextToolCalls,
      correctionRetries: nextRetries,
    };
  }
  toolResultHistory.push({
    name: parsedToolCall.toolName,
    result: toolResult,
  });
  await appendSessionTurn(event.sessionId, {
    role: 'assistant',
    type: 'tool_call',
    content: JSON.stringify({
      name: parsedToolCall.toolName,
      arguments: parsedToolCall.arguments,
    }),
  });
  await appendSessionTurn(event.sessionId, {
    role: 'system',
    type: 'tool_result',
    content: JSON.stringify(toolResult),
    meta: { tool: parsedToolCall.toolName },
  });

  queueEmit({
    type: 'agent:status',
    channel: event.channel,
    sessionId: event.sessionId,
    content: {
      phase: 'tool:complete',
      text: `Tool complete: ${parsedToolCall.toolName}`,
      tool: {
        name: parsedToolCall.toolName,
      },
    },
  });

  messages.push({
    role: 'assistant',
    content: typeof completion.text === 'string' ? completion.text : '',
  });

  messages.push({
    role: 'tool',
    content: JSON.stringify(toolResult),
    tool_call_id: parsedToolCall.toolCallId,
    name: parsedToolCall.toolName,
  });

  return {
    done: false,
    toolCalls: nextToolCalls,
    correctionRetries: 0,
  };
}
