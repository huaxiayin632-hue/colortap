import { createReadStream, promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { isSafeAssetPath } from '../../shared/schema';

export function resolveWithin(root: string, relative: string): string {
  if (!isSafeAssetPath(relative)) throw new Error('素材路径不安全');
  const absolute = path.resolve(root, relative);
  const difference = path.relative(path.resolve(root), absolute);
  if (difference.startsWith('..' + path.sep) || difference === '..' || path.isAbsolute(difference))
    throw new Error('素材超出工程目录');
  return absolute;
}

export async function checkRealPath(root: string, file: string): Promise<void> {
  const [realRoot, realFile] = await Promise.all([fs.realpath(root), fs.realpath(file)]);
  const relative = path.relative(realRoot, realFile);
  if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative))
    throw new Error('素材链接指向工程目录以外的位置');
}

export async function hashFile(file: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

/** Bound filesystem pressure; wait for all in-flight operations before returning a failure. */
export async function eachAsset<T>(
  items: T[],
  operation: (item: T, index: number) => Promise<void>,
): Promise<void> {
  let cursor = 0,
    failed = false;
  const results = await Promise.allSettled(
    Array.from({ length: Math.min(8, items.length) }, async () => {
      while (!failed) {
        const index = cursor++;
        if (index >= items.length) return;
        try {
          await operation(items[index], index);
        } catch (error) {
          failed = true;
          throw error;
        }
      }
    }),
  );
  const failure = results.find((result) => result.status === 'rejected');
  if (failure?.status === 'rejected') throw failure.reason;
}

export async function atomicWrite(file: string, text: string, backup = true): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${randomUUID()}.tmp`);
  try {
    const handle = await fs.open(temporary, 'wx');
    try {
      await handle.writeFile(text, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    if (backup) {
      try {
        await atomicWrite(file + '.bak', await fs.readFile(file, 'utf8'), false);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
    await fs.rename(temporary, file);
  } finally {
    await fs.unlink(temporary).catch(() => undefined);
  }
}
