export const WORKFLOW_STEP_START_EVENT = 'workflow:step:start';

export const STEP_START_EVENTS = new Set([
  WORKFLOW_STEP_START_EVENT,
]);

export const DEFAULT_PROCESSABLE_EVENTS = new Set([
  'user:input',
  'schedule:trigger',
  ...STEP_START_EVENTS,
]);
