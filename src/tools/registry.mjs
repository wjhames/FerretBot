import { createBashTool } from './bash.mjs';
import { createEditTool } from './edit.mjs';
import { createReadTool } from './read.mjs';
import { createWriteTool } from './write.mjs';

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function matchesType(value, expectedType) {
  switch (expectedType) {
    case 'string':
      return typeof value === 'string';
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'integer':
      return Number.isInteger(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'object':
      return isPlainObject(value);
    case 'array':
      return Array.isArray(value);
    default:
      return true;
  }
}

function validateAgainstSchema(schema, args) {
  const errors = [];

  if (!schema) {
    return { valid: true, errors };
  }

  if (!isPlainObject(args)) {
    return {
      valid: false,
      errors: ['arguments must be an object.'],
    };
  }

  if (schema.type && !matchesType(args, schema.type)) {
    errors.push(`arguments must be of type '${schema.type}'.`);
  }

  const properties = isPlainObject(schema.properties) ? schema.properties : {};
  const required = Array.isArray(schema.required) ? schema.required : [];

  for (const key of required) {
    if (!(key in args)) {
      errors.push(`missing required argument '${key}'.`);
    }
  }

  for (const [key, value] of Object.entries(args)) {
    const definition = properties[key];

    if (!definition) {
      if (schema.additionalProperties === false) {
        errors.push(`unexpected argument '${key}'.`);
      }
      continue;
    }

    if (definition.type && !matchesType(value, definition.type)) {
      errors.push(`argument '${key}' must be of type '${definition.type}'.`);
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

const BUILT_IN_TOOLS = [
  {
    name: 'bash',
    description: 'Execute shell commands in the workspace.',
    schema: {
      type: 'object',
      properties: {
        command: { type: 'string' },
        timeoutMs: { type: 'number' },
      },
      required: ['command'],
      additionalProperties: false,
    },
    create: (options) => createBashTool({ cwd: options.cwd }),
  },
  {
    name: 'read',
    description: 'Read file contents with truncation controls.',
    schema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        maxBytes: { type: 'number' },
      },
      required: ['path'],
      additionalProperties: false,
    },
    create: (options) => createReadTool({
      rootDir: options.rootDir,
      rootDirs: options.rootDirs,
      maxBytes: options.maxReadBytes,
    }),
  },
  {
    name: 'edit',
    description: 'Edit existing files in-place using targeted operations.',
    schema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        operation: { type: 'string' },
        search: { type: 'string' },
        replace: { type: 'string' },
        all: { type: 'boolean' },
        pattern: { type: 'string' },
        flags: { type: 'string' },
        marker: { type: 'string' },
        text: { type: 'string' },
        occurrence: { type: 'string' },
        startLine: { type: 'integer' },
        endLine: { type: 'integer' },
      },
      required: ['path', 'operation'],
      additionalProperties: false,
    },
    create: (options) => createEditTool({
      rootDir: options.rootDir,
      rootDirs: options.rootDirs,
    }),
  },
  {
    name: 'write',
    description: 'Write or append text files in the workspace.',
    schema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        content: { type: 'string' },
        mode: { type: 'string' },
        rewriteReason: { type: 'string' },
      },
      required: ['path'],
      additionalProperties: false,
    },
    create: (options) => createWriteTool({ rootDir: options.rootDir, rootDirs: options.rootDirs }),
  },
];

export class ToolRegistry {
  #tools;
  #builtInOptions;

  constructor(options = {}) {
    this.#tools = new Map();
    this.#builtInOptions = {
      cwd: options.cwd ?? process.cwd(),
      rootDir: options.rootDir ?? process.cwd(),
      rootDirs: options.rootDirs,
      maxReadBytes: options.maxReadBytes,
      bus: options.bus,
    };
  }

  register(definition) {
    const normalized = this.#normalizeDefinition(definition);
    this.#tools.set(normalized.name, normalized);
  }

  registerMany(definitions) {
    if (!Array.isArray(definitions)) {
      throw new TypeError('definitions must be an array.');
    }

    for (const definition of definitions) {
      this.register(definition);
    }
  }

  async registerBuiltIns() {
    for (const builtIn of BUILT_IN_TOOLS) {
      if (this.#tools.has(builtIn.name)) {
        continue;
      }

      if (typeof builtIn.shouldRegister === 'function' && !builtIn.shouldRegister(this.#builtInOptions)) {
        continue;
      }

      this.register({
        name: builtIn.name,
        description: builtIn.description,
        schema: builtIn.schema,
        execute: (input, context) => builtIn.create(this.#builtInOptions).execute(input, context),
      });
    }
  }

  has(name) {
    return this.#tools.has(name);
  }

  get(name) {
    return this.#tools.get(name) ?? null;
  }

  list() {
    return [...this.#tools.values()].map((tool) => ({
      name: tool.name,
      description: tool.description,
      schema: tool.schema,
    }));
  }

  validateCall(call = {}) {
    const { name, arguments: args = {} } = call;

    if (typeof name !== 'string' || name.trim().length === 0) {
      return {
        valid: false,
        errors: ['tool name must be a non-empty string.'],
      };
    }

    const tool = this.#tools.get(name);
    if (!tool) {
      return {
        valid: false,
        errors: [`unknown tool '${name}'.`],
      };
    }

    return validateAgainstSchema(tool.schema, args);
  }

  async execute(call = {}) {
    const { name, arguments: args = {}, event } = call;
    const validation = this.validateCall({ name, arguments: args });

    if (!validation.valid) {
      const message = validation.errors.join(' ');
      throw new Error(`Invalid tool call for '${name}': ${message}`);
    }

    const tool = this.#tools.get(name);
    const context = isPlainObject(call.context) ? call.context : {};
    return tool.execute(args, { event, ...context });
  }

  #normalizeDefinition(definition) {
    if (!definition || typeof definition !== 'object') {
      throw new TypeError('Tool definition must be an object.');
    }

    const { name, description = '', schema = null, execute } = definition;

    if (typeof name !== 'string' || name.trim().length === 0) {
      throw new TypeError('Tool definition name must be a non-empty string.');
    }

    if (typeof execute !== 'function') {
      throw new TypeError(`Tool '${name}' must provide an execute function.`);
    }

    return {
      name: name.trim(),
      description: typeof description === 'string' ? description : '',
      schema,
      execute,
    };
  }
}

export function createToolRegistry(options) {
  return new ToolRegistry(options);
}

export { validateAgainstSchema, BUILT_IN_TOOLS };
