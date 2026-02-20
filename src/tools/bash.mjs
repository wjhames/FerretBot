import { exec } from 'node:child_process';
import { promisify } from 'node:util';

const execAsync = promisify(exec);

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_BUFFER_BYTES = 1024 * 1024;
const BLOCKED_COMMAND_PATTERN = /\bls\s+-R\b/;
const BLOCKED_COMMAND_MESSAGE = 'Blocked command pattern detected: recursive directory listing is not allowed.';
const BLOCKED_COMMAND_GUIDANCE = 'Use a non-recursive listing such as `ls` or a targeted path.';

export class BashTool {
  #cwd;
  #timeoutMs;
  #maxBuffer;

  constructor(options = {}) {
    this.#cwd = options.cwd ?? process.cwd();
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#maxBuffer = options.maxBuffer ?? DEFAULT_MAX_BUFFER_BYTES;
  }

  async execute(input = {}) {
    const { command, timeoutMs = this.#timeoutMs } = input;

    if (typeof command !== 'string' || command.trim().length === 0) {
      throw new TypeError('command must be a non-empty string.');
    }

    if (BLOCKED_COMMAND_PATTERN.test(command)) {
      return {
        success: false,
        exitCode: null,
        stdout: '',
        stderr: BLOCKED_COMMAND_MESSAGE,
        blocked: true,
        errorCode: 'GUARDRAIL_BLOCKED_COMMAND',
        retryGuidance: BLOCKED_COMMAND_GUIDANCE,
        timedOut: false,
      };
    }

    try {
      const { stdout, stderr } = await execAsync(command, {
        cwd: this.#cwd,
        timeout: timeoutMs,
        maxBuffer: this.#maxBuffer,
      });

      return {
        success: true,
        exitCode: 0,
        stdout,
        stderr,
        timedOut: false,
      };
    } catch (error) {
      const timedOut = Boolean(error?.killed) && error?.signal === 'SIGTERM';
      const timeoutMessage = `Command timed out after ${timeoutMs}ms.`;

      return {
        success: false,
        exitCode: Number.isInteger(error.code) ? error.code : null,
        stdout: typeof error.stdout === 'string' ? error.stdout : '',
        stderr: timedOut
          ? timeoutMessage
          : (typeof error.stderr === 'string' && error.stderr.length > 0
            ? error.stderr
            : String(error.message ?? 'Unknown error')),
        timedOut,
      };
    }
  }
}

export function createBashTool(options) {
  return new BashTool(options);
}

export { DEFAULT_TIMEOUT_MS, DEFAULT_MAX_BUFFER_BYTES };
