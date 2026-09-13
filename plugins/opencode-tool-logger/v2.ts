import { errorMessage } from './context.ts';
import type { MetadataError } from './context.ts';
import { createEventLogger } from './log.ts';

type V2HookName = 'execute.before' | 'execute.after';
type V2Callback = (event: unknown) => void;
const MAX_SESSION_DIRECTORIES = 256;

export type V2Registration = {
  dispose: () => Promise<void>;
};

export type V2Context = {
  tool: {
    hook: (name: V2HookName, callback: V2Callback) => Promise<V2Registration>;
  };
  session?: {
    get: (input: { sessionID: string }) => Promise<unknown>;
  };
  location?: unknown;
};

function sessionID(event: unknown): string | null {
  if (typeof event !== 'object' || event === null || Array.isArray(event)) return null;
  if (!('sessionID' in event) || typeof event.sessionID !== 'string') return null;
  return event.sessionID;
}

function locationDirectory(value: unknown): string | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  if (!('location' in value)) return null;
  const location = value.location;
  if (typeof location !== 'object' || location === null || Array.isArray(location)) return null;
  if (!('directory' in location) || typeof location.directory !== 'string') return null;
  return location.directory;
}

function responseDirectory(value: unknown): string | null {
  const direct = locationDirectory(value);
  if (direct) return direct;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  return 'data' in value ? locationDirectory(value.data) : null;
}

function fallbackDirectory(location: unknown): string | null {
  if (typeof location !== 'object' || location === null || Array.isArray(location)) return null;
  if (!('directory' in location) || typeof location.directory !== 'string') return null;
  return location.directory;
}

function boundedSessionGet(context: V2Context, id: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const session = context.session;
    if (!session) { reject(new Error('session client unavailable')); return; }
    const timer = setTimeout(() => { reject(new Error('session lookup timed out')); }, 250);
    session.get({ sessionID: id }).then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error: unknown) => { clearTimeout(timer); reject(error); },
    );
  });
}

async function eventContext(
  context: V2Context,
  id: string | null,
  directories: Map<string, string>,
): Promise<{ cwd: string | null; errors: MetadataError[] }> {
  const fallback = fallbackDirectory(context.location);
  if (!id || !context.session) return { cwd: fallback, errors: [] };
  const cached = directories.get(id);
  if (cached) return { cwd: cached, errors: [] };
  try {
    const session = await boundedSessionGet(context, id);
    const cwd = responseDirectory(session) ?? fallback;
    if (cwd) {
      if (!directories.has(id) && directories.size >= MAX_SESSION_DIRECTORIES) {
        const oldest = directories.keys().next().value;
        if (typeof oldest === 'string') directories.delete(oldest);
      }
      directories.set(id, cwd);
    }
    return { cwd, errors: [] };
  } catch (error) {
    return {
      cwd: fallback,
      errors: [{ source: 'session', message: errorMessage(error) }],
    };
  }
}

const plugin = {
  id: 'opencode-tool-logger',
  async setup(context: V2Context): Promise<() => Promise<void>> {
    const directories = new Map<string, string>();
    const logger = createEventLogger();
    const before = await context.tool.hook('execute.before', (event) => {
      const id = sessionID(event);
      logger.appendV2('tool.execute.before', event, () => eventContext(context, id, directories));
    });
    let after: V2Registration;
    try {
      after = await context.tool.hook('execute.after', (event) => {
        const id = sessionID(event);
        logger.appendV2('tool.execute.after', event, () => eventContext(context, id, directories));
      });
    } catch (error) {
      try { await before.dispose(); }
      catch { /* Preserve registration failure. */ }
      await logger.drain();
      throw error;
    }
    return async () => {
      await Promise.allSettled([before.dispose(), after.dispose()]);
      await logger.drain();
    };
  },
};

export default plugin;
