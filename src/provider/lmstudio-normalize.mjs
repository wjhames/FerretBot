function safeJsonParse(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

export function normalizeContent(content) {
  if (typeof content === 'string') {
    return content;
  }

  if (!Array.isArray(content)) {
    return '';
  }

  const parts = content
    .map((part) => {
      if (!part || typeof part !== 'object') {
        return '';
      }

      if (typeof part.text === 'string') {
        return part.text;
      }

      if (typeof part.content === 'string') {
        return part.content;
      }

      return '';
    })
    .filter((part) => part.length > 0);

  return parts.join('\n');
}

export function normalizeToolCalls(firstChoice) {
  const message = firstChoice?.message;

  if (Array.isArray(message?.tool_calls)) {
    return message.tool_calls
      .map((call) => {
        const name = call?.function?.name;
        if (typeof name !== 'string' || name.length === 0) {
          return null;
        }

        const rawArguments = call?.function?.arguments;
        const parsedArgs = typeof rawArguments === 'string' ? safeJsonParse(rawArguments) : rawArguments;

        return {
          id: typeof call?.id === 'string' ? call.id : null,
          type: call?.type ?? 'function',
          name,
          arguments:
            parsedArgs &&
            typeof parsedArgs === 'object' &&
            !Array.isArray(parsedArgs)
              ? parsedArgs
              : {},
        };
      })
      .filter(Boolean);
  }

  if (message?.function_call?.name) {
    const parsedArgs = safeJsonParse(message.function_call.arguments);
    return [
      {
        id: null,
        type: 'function',
        name: message.function_call.name,
        arguments:
          parsedArgs &&
          typeof parsedArgs === 'object' &&
          !Array.isArray(parsedArgs)
            ? parsedArgs
            : {},
      },
    ];
  }

  return [];
}

export function normalizeCompletionText(firstChoice, toolCalls) {
  const content = normalizeContent(firstChoice?.message?.content);
  if (content.length > 0) {
    return content;
  }

  if (Array.isArray(toolCalls) && toolCalls.length > 0) {
    const first = toolCalls[0];
    return JSON.stringify({ tool: first.name, args: first.arguments });
  }

  if (typeof firstChoice?.text === 'string') {
    return firstChoice.text;
  }

  return '';
}

export function normalizeUsage(usage) {
  return {
    promptTokens: usage?.prompt_tokens ?? 0,
    completionTokens: usage?.completion_tokens ?? 0,
    totalTokens: usage?.total_tokens ?? 0,
  };
}

export function normalizeToolDefinitions(tools) {
  if (!Array.isArray(tools) || tools.length === 0) {
    return undefined;
  }

  return tools
    .map((tool) => {
      if (!tool || typeof tool !== 'object') {
        return null;
      }

      const name = tool?.function?.name ?? tool?.name;
      if (typeof name !== 'string' || name.trim().length === 0) {
        return null;
      }

      const description = tool?.function?.description ?? tool?.description ?? '';
      const parameters = tool?.function?.parameters ?? tool?.schema ?? { type: 'object', properties: {} };

      return {
        type: 'function',
        function: {
          name: name.trim(),
          description: typeof description === 'string' ? description : '',
          parameters,
        },
      };
    })
    .filter(Boolean);
}
