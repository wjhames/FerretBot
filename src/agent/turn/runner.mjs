import {
  buildContinuationPrompt,
  buildCorrectionPrompt,
  parseCompletion,
  shouldContinueCompletion,
  toToolCallFromNative,
  toToolCallFromParsed,
} from './policy.mjs';
import { createTurnWriteRollback } from './write-rollback.mjs';

async function rollbackTurnWrites({ event, queueEmit, writeRollback }) {
  if (!writeRollback || typeof writeRollback.hasChanges !== 'function') {
    return;
  }

  if (!writeRollback.hasChanges()) {
    return;
  }

  try {
    const restored = await writeRollback.restore();
    queueEmit({
      type: 'agent:status',
      channel: event.channel,
      sessionId: event.sessionId,
      content: {
        phase: 'tool:rollback',
        text: `Reverted ${restored} file change(s) from failed turn.`,
      },
    });
  } catch (error) {
    queueEmit({
      type: 'agent:status',
      channel: event.channel,
      sessionId: event.sessionId,
      content: {
        phase: 'tool:rollback_failed',
        text: 'Failed to revert one or more file changes from failed turn.',
        detail: error?.message ?? String(error),
      },
    });
  }
}

export async function runAgentTurn(options = {}) {
  const {
    event,
    provider,
    parser,
    maxContinuations,
    retryLimit,
    compactMessagesForContinuation,
    getToolDefinitionsForEvent,
    buildInitialContext,
    persistInputTurn,
    emitFinal,
    emitCorrectionFailure,
    queueEmit,
    executeToolCall,
    createWriteRollback = createTurnWriteRollback,
  } = options;

  const initial = await buildInitialContext(event);
  const state = {
    messages: initial.messages,
    maxOutputTokens: initial.maxOutputTokens,
    toolCalls: 0,
    toolCallHistory: [],
    toolResultHistory: [],
    correctionRetries: 0,
    continuationCount: 0,
    accumulatedTextParts: [],
  };
  const writeRollback = createWriteRollback();

  await persistInputTurn(event);

  while (true) {
    const completion = await provider.chatCompletion({
      messages: state.messages,
      maxTokens: state.maxOutputTokens,
      tools: getToolDefinitionsForEvent(event),
      toolChoice: 'auto',
    });

    const nativeToolCall = toToolCallFromNative(completion);
    if (nativeToolCall) {
      const handled = await executeToolCall({
        event,
        messages: state.messages,
        completion,
        parsedToolCall: nativeToolCall,
        toolCalls: state.toolCalls,
        toolCallHistory: state.toolCallHistory,
        toolResultHistory: state.toolResultHistory,
        correctionRetries: state.correctionRetries,
        toolExecutionContext: { writeRollback },
      });
      state.toolCalls = handled.toolCalls;
      state.correctionRetries = handled.correctionRetries;

      if (handled.done) {
        await rollbackTurnWrites({ event, queueEmit, writeRollback });
        return;
      }
      continue;
    }

    const parsed = parseCompletion(completion, parser);

    if (parsed.kind === 'emit_final') {
      if (shouldContinueCompletion(completion, state.continuationCount, maxContinuations)) {
        state.continuationCount += 1;
        const textPart = typeof parsed.text === 'string' ? parsed.text : '';
        if (textPart.length > 0) {
          state.accumulatedTextParts.push(textPart);
        }

        state.messages.push({
          role: 'assistant',
          content: typeof completion.text === 'string' ? completion.text : '',
        });
        state.messages.push({ role: 'user', content: buildContinuationPrompt() });

        const compacted = await compactMessagesForContinuation({
          messages: state.messages,
          maxOutputTokens: state.maxOutputTokens,
          continuationCount: state.continuationCount,
          lastCompletionText: textPart,
        });
        state.messages = compacted.messages;
        state.maxOutputTokens = compacted.maxOutputTokens;

        queueEmit({
          type: 'agent:status',
          channel: event.channel,
          sessionId: event.sessionId,
          content: {
            phase: 'generation:continue',
            text: `Continuing truncated response (${state.continuationCount}/${maxContinuations}).`,
          },
        });
        continue;
      }

      const fullText = `${state.accumulatedTextParts.join('')}${typeof parsed.text === 'string' ? parsed.text : ''}`;
      await emitFinal(event, completion, fullText, {
        toolCalls: state.toolCallHistory,
        toolResults: state.toolResultHistory,
      });
      return;
    }

    if (parsed.kind === 'retry_parse') {
      const shouldRetry = state.correctionRetries < retryLimit;
      if (!shouldRetry) {
        await rollbackTurnWrites({ event, queueEmit, writeRollback });
        emitCorrectionFailure(event, 'Unable to parse model tool JSON after retries.');
        return;
      }

      state.correctionRetries += 1;
      state.messages.push({ role: 'assistant', content: completion.text });
      state.messages.push({ role: 'system', content: buildCorrectionPrompt(parsed.error) });
      queueEmit({
        type: 'agent:status',
        channel: event.channel,
        sessionId: event.sessionId,
        content: {
          phase: 'parse:retry',
          text: `Retrying response parse (${state.correctionRetries}/${retryLimit}).`,
        },
      });
      continue;
    }

    const handled = await executeToolCall({
      event,
      messages: state.messages,
      completion,
      parsedToolCall: toToolCallFromParsed(parsed, completion),
      toolCalls: state.toolCalls,
      toolCallHistory: state.toolCallHistory,
      toolResultHistory: state.toolResultHistory,
      correctionRetries: state.correctionRetries,
      toolExecutionContext: { writeRollback },
    });
    state.toolCalls = handled.toolCalls;
    state.correctionRetries = handled.correctionRetries;

    if (handled.done) {
      await rollbackTurnWrites({ event, queueEmit, writeRollback });
      return;
    }
  }
}
