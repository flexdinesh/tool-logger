import { createEventLogger } from './log.ts';

export type V1Context = {
  directory?: string;
};

type V1Callback = (input: unknown, output: unknown) => void;

export type V1Hooks = {
  'tool.execute.before': V1Callback;
  'tool.execute.after': V1Callback;
};

export default function opencodeToolLoggerV1(context: V1Context): V1Hooks {
  const sessionCwd = typeof context.directory === 'string' && context.directory
    ? context.directory : null;
  const logger = createEventLogger();
  return {
    'tool.execute.before': (input, output) => {
      logger.appendV1('tool.execute.before', input, output, sessionCwd);
    },
    'tool.execute.after': (input, output) => {
      logger.appendV1('tool.execute.after', input, output, sessionCwd);
    },
  };
}
