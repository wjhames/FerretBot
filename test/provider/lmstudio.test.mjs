import test from 'node:test';
import assert from 'node:assert/strict';

import { createLmStudioProvider } from '../../src/provider/lmstudio.mjs';

test('chatCompletion posts LM Studio payload and normalizes result', async () => {
  const calls = [];
  const provider = createLmStudioProvider({
    baseUrl: 'http://localhost:1234/v1',
    model: 'gpt-oss:20b',
    temperature: 0.2,
    topP: 0.9,
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return {
        ok: true,
        async json() {
          return {
            id: 'chatcmpl_1',
            model: 'gpt-oss:20b',
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
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'http://localhost:1234/v1/chat/completions');

  const payload = JSON.parse(calls[0].init.body);
  assert.equal(payload.model, 'gpt-oss:20b');
  assert.equal(payload.max_tokens, 256);
  assert.equal(payload.temperature, 0.2);
  assert.equal(payload.top_p, 0.9);
  assert.equal(payload.stream, false);
  assert.deepEqual(payload.messages, [{ role: 'user', content: 'hi' }]);

  assert.equal(result.text, 'hello from model');
  assert.equal(result.finishReason, 'stop');
  assert.deepEqual(result.usage, {
    promptTokens: 100,
    completionTokens: 25,
    totalTokens: 125,
  });
});

test('chatCompletion rejects calls without explicit maxTokens', async () => {
  const provider = createLmStudioProvider({
    model: 'gpt-oss:20b',
    fetchImpl: async () => {
      throw new Error('fetch should not be called when maxTokens is invalid');
    },
  });

  await assert.rejects(
    provider.chatCompletion({ messages: [{ role: 'user', content: 'hi' }] }),
    /maxTokens must be a positive integer/,
  );
});

test('chatCompletion normalizes OpenAI content arrays and tool_calls', async () => {
  const provider = createLmStudioProvider({
    model: 'gpt-oss:20b',
    fetchImpl: async () => ({
      ok: true,
      async json() {
        return {
          id: 'chatcmpl_2',
          model: 'gpt-oss:20b',
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

  const contentResult = await provider.chatCompletion({
    messages: [{ role: 'user', content: 'hi' }],
    maxTokens: 128,
  });
  assert.equal(contentResult.text, 'part 1\npart 2');

  const providerWithToolCalls = createLmStudioProvider({
    model: 'gpt-oss:20b',
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
        };
      },
    }),
  });

  const toolCallResult = await providerWithToolCalls.chatCompletion({
    messages: [{ role: 'user', content: 'use tool' }],
    maxTokens: 128,
  });

  assert.equal(toolCallResult.text, '{"tool":"bash","args":{"command":"pwd"}}');
  assert.equal(toolCallResult.finishReason, 'tool_calls');
});
