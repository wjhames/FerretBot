import { toText } from './token-utils.mjs';

const CONTINUATION_KEEP_IF_POSSIBLE_TAIL = 8;
const CONTINUATION_SUMMARY_LIMIT = 6;
const CONTINUATION_SUMMARY_SNIPPET_LENGTH = 80;

function summarizeMessages(messages = []) {
  if (!Array.isArray(messages) || messages.length === 0) {
    return '';
  }

  return messages
    .slice(-CONTINUATION_SUMMARY_LIMIT)
    .map((message) => {
      const role = toText(message?.role).trim() || 'unknown';
      const content = toText(message?.content).trim();
      if (content.length === 0) {
        return `${role}: [no content]`;
      }
      const snippet = content.length > CONTINUATION_SUMMARY_SNIPPET_LENGTH
        ? `${content.slice(0, CONTINUATION_SUMMARY_SNIPPET_LENGTH)}...`
        : content;
      return `${role}: ${snippet}`;
    })
    .join(' | ');
}

export async function compactMessagesForContinuation(options = {}) {
  const {
    messages = [],
    maxOutputTokens,
    continuationCount = 0,
    lastCompletionText = '',
    contextLimit,
    outputReserve,
    completionSafetyBuffer,
    estimateMessagesTokens,
    estimateTextTokens,
  } = options;

  if (!Array.isArray(messages) || messages.length === 0) {
    return {
      messages: [],
      maxOutputTokens: Math.max(1, outputReserve),
      compacted: false,
    };
  }

  const inputBudget = Math.max(
    1,
    contextLimit - Math.max(1, Math.floor(maxOutputTokens)) - completionSafetyBuffer,
  );
  const keepTailStart = Math.max(0, messages.length - CONTINUATION_KEEP_IF_POSSIBLE_TAIL);

  const mustKeep = [];
  const keepIfPossible = [];
  const evictFirst = [];
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    const role = message?.role;
    if (role === 'system' || role === 'tool' || index >= messages.length - 2) {
      mustKeep.push(message);
      continue;
    }
    if (index >= keepTailStart) {
      keepIfPossible.push(message);
      continue;
    }
    evictFirst.push(message);
  }

  const dropped = [];
  const candidate = [...messages];
  const mustKeepSet = new Set(mustKeep);
  let estimated = await estimateMessagesTokens(candidate);
  if (estimated > inputBudget) {
    const orderedDrops = [...evictFirst, ...keepIfPossible];
    for (const drop of orderedDrops) {
      if (estimated <= inputBudget) {
        break;
      }
      if (mustKeepSet.has(drop)) {
        continue;
      }
      const index = candidate.indexOf(drop);
      if (index === -1) {
        continue;
      }
      candidate.splice(index, 1);
      dropped.push(drop);
      estimated = await estimateMessagesTokens(candidate);
    }
  }

  let compactedMessages = candidate;
  if (dropped.length > 0) {
    const summary = summarizeMessages(dropped);
    if (summary) {
      const summaryMessage = {
        role: 'system',
        content: `Compacted earlier context:\n${summary}`,
      };
      compactedMessages = [...candidate];
      const insertAt = compactedMessages.findLastIndex((message) => message?.role === 'system');
      compactedMessages.splice(insertAt >= 0 ? insertAt + 1 : 0, 0, summaryMessage);

      let summaryText = summary;
      while (summaryText.length > 16) {
        const compactedTokens = await estimateMessagesTokens(compactedMessages);
        if (compactedTokens <= inputBudget) {
          break;
        }
        summaryText = `${summaryText.slice(0, Math.floor(summaryText.length * 0.8)).trim()}...`;
        summaryMessage.content = `Compacted earlier context:\n${summaryText}`;
      }
    }
  }

  const finalInputTokens = await estimateMessagesTokens(compactedMessages);
  const availableOutput = Math.max(1, contextLimit - finalInputTokens - completionSafetyBuffer);
  const lastCompletionTokens = await estimateTextTokens(lastCompletionText);
  const priorBasedTarget = Math.max(
    64,
    lastCompletionTokens > 0 ? Math.ceil(lastCompletionTokens * 1.8) : outputReserve,
  );
  const continuationTarget = continuationCount <= 0
    ? availableOutput
    : Math.min(availableOutput, priorBasedTarget);

  return {
    messages: compactedMessages,
    maxOutputTokens: Math.max(1, Math.floor(continuationTarget)),
    compacted: dropped.length > 0,
  };
}
