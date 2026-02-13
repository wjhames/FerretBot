function safeJsonParse(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function extractJsonCandidate(text) {
  if (typeof text !== 'string') {
    return null;
  }

  const fencedMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fencedMatch) {
    return fencedMatch[1].trim();
  }

  const firstBrace = text.indexOf('{');
  const lastBrace = text.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
    return text.slice(firstBrace, lastBrace + 1);
  }

  return null;
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

export class AgentParser {
  parse(rawText) {
    const text = typeof rawText === 'string' ? rawText.trim() : '';
    if (text.length === 0) {
      return {
        kind: 'final',
        text: '',
      };
    }

    const directParsed = safeJsonParse(text);
    const fromDirectJson = parseToolCallObject(directParsed);
    if (fromDirectJson) {
      return fromDirectJson;
    }

    const jsonCandidate = extractJsonCandidate(text);
    if (jsonCandidate) {
      const embeddedParsed = safeJsonParse(jsonCandidate);
      const fromEmbeddedJson = parseToolCallObject(embeddedParsed);
      if (fromEmbeddedJson) {
        return fromEmbeddedJson;
      }
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
