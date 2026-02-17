import { buildCorrectionPrompt } from './policy.mjs';

export async function executeToolCall(options = {}) {
  const {
    event,
    messages,
    completion,
    parsedToolCall,
    toolCalls,
    correctionRetries,
    retryLimit,
    maxToolCallsPerStep,
    toolRegistry,
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
    queueEmit({
      type: 'agent:response',
      channel: event.channel,
      sessionId: event.sessionId,
      content: {
        text: 'Tool call limit reached before final response.',
        finishReason: 'tool_limit',
        usage: completion.usage,
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

  const toolResult = await toolRegistry.execute({
    name: parsedToolCall.toolName,
    arguments: parsedToolCall.arguments,
    event,
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
