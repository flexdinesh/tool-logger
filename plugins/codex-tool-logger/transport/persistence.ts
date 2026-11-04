import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdir, open, rename, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function code(error: unknown): string | null {
  return error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code : null;
}

export async function atomicJson(path: string, value: unknown): Promise<void> {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = join(directory, `.transport-${randomUUID()}.tmp`);
  try {
    const file = await open(temporary, 'wx', 0o600);
    try {
      await file.writeFile(JSON.stringify(value) + '\n');
      await file.sync();
    } finally { await file.close(); }
    await rename(temporary, path);
    const parent = await open(directory, constants.O_RDONLY);
    try { await parent.sync(); }
    finally { await parent.close(); }
  } finally { await unlink(temporary).catch(() => {}); }
}

export async function readJson(path: string, maxBytes = 64 * 1024, privateFile = false): Promise<unknown> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > maxBytes || (privateFile && (stat.mode & 0o077) !== 0)) {
      throw new Error('Invalid transport state or file permissions');
    }
    // Bound reads even if another process grows the file after stat.
    const bytes = Buffer.alloc(maxBytes + 1);
    let length = 0;
    while (length < bytes.length) {
      const { bytesRead } = await file.read(bytes, length, bytes.length - length, length);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > maxBytes) throw new Error('Transport state too large');
    const value: unknown = JSON.parse(bytes.subarray(0, length).toString('utf8'));
    return value;
  } finally { await file.close(); }
}
