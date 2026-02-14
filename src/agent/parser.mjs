function safeJsonParse(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

const MAX_ERROR_SNIPPET_CHARS = 280;

function compactErrorSnippet(text) {
  if (typeof text !== 'string') {
    return '';
  }

  const normalized = text.replace(/\s+/g, ' ').trim();
  if (normalized.length <= MAX_ERROR_SNIPPET_CHARS) {
    return normalized;
  }

  return `${normalized.slice(0, MAX_ERROR_SNIPPET_CHARS - 3)}...`;
}

function extractJsonCandidates(text) {
  if (typeof text !== 'string') {
    return [];
  }

  const candidates = [];
  const fencedMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/ig);
  if (fencedMatch) {
    fencedMatch.forEach((match) => {
      const inner = match.replace(/```(?:json)?/i, '').replace(/```$/, '').trim();
      if (inner.length > 0) {
        candidates.push(inner);
      }
    });
  }

  let depth = 0;
  let start = -1;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === '{') {
      if (depth === 0) {
        start = index;
      }
      depth += 1;
    } else if (char === '}') {
      depth -= 1;
      if (depth === 0 && start !== -1) {
        candidates.push(text.slice(start, index + 1));
        start = -1;
      }
    }
  }

  return candidates;
}

function sanitizeJsonString(text) {
  if (typeof text !== 'string') {
    return '';
  }

  // Cheap normalization for common model mistakes (e.g. trailing commas).
  return text.replace(/,\s*([}\]])/g, '$1').trim();
}

function looksLikeToolJson(text) {
  if (typeof text !== 'string') {
    return false;
  }

  const trimmed = text.trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('```')) {
    return false;
  }

  return /"?(tool|name|args|arguments)"?\s*:/.test(trimmed);
}

function coerceArguments(value) {
  if (value == null) {
    return {};
  }

  if (typeof value === 'string') {
    const parsed = safeJsonParse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  }

  if (typeof value === 'object' && !Array.isArray(value)) {
    return value;
  }

  return {};
}

function parseToolCallObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }

  const candidates = [];

  if (value.tool_calls && Array.isArray(value.tool_calls)) {
    candidates.push(value.tool_calls[0]);
  }

  if (value.tool_call && typeof value.tool_call === 'object') {
    candidates.push(value.tool_call);
  }

  candidates.push(value);

  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
      continue;
    }

    const name = candidate.name ?? candidate.tool ?? candidate.toolName;
    if (typeof name !== 'string' || name.length === 0) {
      continue;
    }

    const args = coerceArguments(candidate.arguments ?? candidate.args ?? candidate.input);

    return {
      kind: 'tool_call',
      toolName: name,
      arguments: args,
    };
  }

  return null;
}

function parseToolCallValue(value, sourceText) {
  if (Array.isArray(value)) {
    for (const element of value) {
      const parsed = parseToolCallValue(element, sourceText);
      if (parsed) {
        return parsed;
      }
    }
    return null;
  }

  const parsed = parseToolCallObject(value);
  if (!parsed) {
    return null;
  }

  if (sourceText && typeof sourceText === 'string') {
    return { ...parsed, rawJson: sourceText };
  }

  return parsed;
}

function tryParseCandidate(candidateText) {
  const parsedValue = safeJsonParse(candidateText) ?? safeJsonParse(sanitizeJsonString(candidateText));
  if (!parsedValue) {
    return null;
  }

  return parseToolCallValue(parsedValue, candidateText);
}

export class AgentParser {
  parse(rawText) {
    const text = typeof rawText === 'string' ? rawText.trim() : '';
    if (text.length === 0) {
      return {
        kind: 'final',
        text: '',
      };
    }

    const directParsed = safeJsonParse(text) ?? safeJsonParse(sanitizeJsonString(text));
    const fromDirectJson = parseToolCallValue(directParsed, text);
    if (fromDirectJson) {
      return fromDirectJson;
    }

    const jsonCandidates = extractJsonCandidates(text);
    for (const candidate of jsonCandidates) {
      const parsedCandidate = tryParseCandidate(candidate);
      if (parsedCandidate) {
        return parsedCandidate;
      }
    }

    const errorHint = compactErrorSnippet(jsonCandidates.length > 0 ? jsonCandidates[0] : text);
    if (jsonCandidates.length > 0 || looksLikeToolJson(text)) {
      return {
        kind: 'parse_error',
        text,
        error: `Unable to parse tool call JSON. Candidate snippet: ${errorHint}`,
      };
    }

    return {
      kind: 'final',
      text,
    };
  }
}

export function createAgentParser() {
  return new AgentParser();
}
