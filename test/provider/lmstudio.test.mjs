import test from 'node:test';
import assert from 'node:assert/strict';

import { createLmStudioProvider } from '../../src/provider/lmstudio.mjs';

test('chatCompletion posts OpenAI-compatible payload with tools and normalizes result', async () => {
  const calls = [];
  const provider = createLmStudioProvider({
    baseUrl: 'http://localhost:1234/v1',
    model: 'openai/gpt-oss-20b',
    temperature: 0.2,
    topP: 0.9,
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return {
        ok: true,
        async json() {
          return {
            id: 'chatcmpl_1',
            model: 'openai/gpt-oss-20b',
            choices: [
              {
                message: { role: 'assistant', content: 'hello from model' },
                finish_reason: 'stop',
              },
            ],
            usage: {
              prompt_tokens: 100,
              completion_tokens: 25,
              total_tokens: 125,
            },
          };
        },
      };
    },
  });

  const result = await provider.chatCompletion({
    messages: [{ role: 'user', content: 'hi' }],
    maxTokens: 256,
    tools: [
      {
        name: 'read',
        description: 'Read files',
        schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
      },
    ],
    toolChoice: 'auto',
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'http://localhost:1234/v1/chat/completions');

  const payload = JSON.parse(calls[0].init.body);
  assert.equal(payload.model, 'openai/gpt-oss-20b');
  assert.equal(payload.max_tokens, 256);
  assert.equal(payload.temperature, 0.2);
  assert.equal(payload.top_p, 0.9);
  assert.equal(payload.stream, false);
  assert.deepEqual(payload.messages, [{ role: 'user', content: 'hi' }]);
  assert.equal(payload.tools[0].type, 'function');
  assert.equal(payload.tools[0].function.name, 'read');
  assert.equal(payload.tool_choice, 'auto');

  assert.equal(result.text, 'hello from model');
  assert.equal(result.finishReason, 'stop');
  assert.deepEqual(result.toolCalls, []);
  assert.deepEqual(result.usage, {
    promptTokens: 100,
    completionTokens: 25,
    totalTokens: 125,
  });
});

test('chatCompletion normalizes content arrays and tool_calls', async () => {
  const providerWithArrayContent = createLmStudioProvider({
    model: 'openai/gpt-oss-20b',
    fetchImpl: async () => ({
      ok: true,
      async json() {
        return {
          choices: [
            {
              message: {
                role: 'assistant',
                content: [{ type: 'text', text: 'part 1' }, { type: 'text', text: 'part 2' }],
              },
              finish_reason: 'stop',
            },
          ],
          usage: {},
        };
      },
    }),
  });

  const contentResult = await providerWithArrayContent.chatCompletion({
    messages: [{ role: 'user', content: 'hi' }],
    maxTokens: 128,
  });
  assert.equal(contentResult.text, 'part 1\npart 2');

  const providerWithToolCalls = createLmStudioProvider({
    model: 'openai/gpt-oss-20b',
    fetchImpl: async () => ({
      ok: true,
      async json() {
        return {
          choices: [
            {
              message: {
                role: 'assistant',
                content: null,
                tool_calls: [
                  {
                    id: 'call_1',
                    type: 'function',
                    function: {
                      name: 'bash',
                      arguments: '{"command":"pwd"}',
                    },
                  },
                ],
              },
              finish_reason: 'tool_calls',
            },
          ],
          usage: {},
        };
      },
    }),
  });

  const toolCallResult = await providerWithToolCalls.chatCompletion({
    messages: [{ role: 'user', content: 'use tool' }],
    maxTokens: 128,
  });

  assert.equal(toolCallResult.finishReason, 'tool_calls');
  assert.equal(toolCallResult.toolCalls.length, 1);
  assert.equal(toolCallResult.toolCalls[0].id, 'call_1');
  assert.equal(toolCallResult.toolCalls[0].name, 'bash');
  assert.deepEqual(toolCallResult.toolCalls[0].arguments, { command: 'pwd' });
  assert.equal(toolCallResult.text, '{"tool":"bash","args":{"command":"pwd"}}');
});

test('chatCompletion rejects calls without explicit maxTokens', async () => {
  const provider = createLmStudioProvider({
    model: 'openai/gpt-oss-20b',
    fetchImpl: async () => {
      throw new Error('fetch should not be called when maxTokens is invalid');
    },
  });

  await assert.rejects(
    provider.chatCompletion({ messages: [{ role: 'user', content: 'hi' }] }),
    /maxTokens must be a positive integer/,
  );
});

test('discoverModelCapabilities returns model context window and caches result', async () => {
  const calls = [];
  const provider = createLmStudioProvider({
    model: 'openai/gpt-oss-20b',
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return {
        ok: true,
        async json() {
          return {
            data: [
              { id: 'other-model', context_length: 4096 },
              { id: 'openai/gpt-oss-20b', context_length: 32768 },
            ],
          };
        },
      };
    },
  });

  const first = await provider.discoverModelCapabilities();
  const second = await provider.discoverModelCapabilities();

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'http://192.168.1.7:1234/v1/models');
  assert.equal(calls[0].init.method, 'GET');
  assert.deepEqual(first, {
    model: 'openai/gpt-oss-20b',
    contextWindow: 32768,
    supportsTokenCounting: true,
  });
  assert.deepEqual(second, first);
});

test('discoverModelCapabilities can require configured model to exist', async () => {
  const provider = createLmStudioProvider({
    model: 'missing-model',
    fetchImpl: async () => ({
      ok: true,
      async json() {
        return {
          data: [
            { id: 'other-model', context_length: 4096 },
          ],
        };
      },
    }),
  });

  await assert.rejects(
    provider.discoverModelCapabilities({ requireDefaultModel: true }),
    /Configured LM Studio model 'missing-model' was not found/,
  );
});

test('countTokens uses tokenize endpoint and returns token length', async () => {
  const calls = [];
  const provider = createLmStudioProvider({
    model: 'openai/gpt-oss-20b',
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return {
        ok: true,
        async json() {
          return { tokens: [1, 2, 3, 4] };
        },
      };
    },
  });

  const count = await provider.countTokens([
    { role: 'system', content: 'rules' },
    { role: 'user', content: 'hello' },
  ]);

  assert.equal(count, 4);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'http://192.168.1.7:1234/v1/tokenize');
  assert.equal(calls[0].init.method, 'POST');
});

test('countTokens returns null when tokenize endpoint is unavailable', async () => {
  const provider = createLmStudioProvider({
    model: 'openai/gpt-oss-20b',
    fetchImpl: async () => ({
      ok: false,
      status: 404,
      async text() {
        return 'not found';
      },
    }),
  });

  const count = await provider.countTokens('hello');
  assert.equal(count, null);
});
