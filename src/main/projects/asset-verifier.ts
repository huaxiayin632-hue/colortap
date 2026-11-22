import { promises as fs, type BigIntStats } from 'node:fs';
import { createHash } from 'node:crypto';
import type { Asset } from '../../shared/models';
import { checkRealPath } from './file-io';

function stamp(stat: BigIntStats): string {
  return [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs, stat.birthtimeNs].join(':');
}

/** Only reuse a digest while the filesystem identity AND change stamp still match.
 * Containment and existence are checked on every access; entries never survive restart.
 */
export class AssetVerifier {
  private verified = new Map<string, string>();

  async check(root: string, file: string, asset: Asset, read = false): Promise<Buffer | undefined> {
    await checkRealPath(root, file);
    if (!read) {
      const current = await fs.stat(file, { bigint: true });
      if (
        current.isFile() &&
        current.size === BigInt(asset.byteLength) &&
        current.ino !== 0n &&
        current.ctimeNs > 0n &&
        current.mtimeNs > 0n &&
        this.verified.get(stamp(current)) === asset.sha256
      )
        return;
    }
    const handle = await fs.open(file, 'r');
    try {
      const before = await handle.stat({ bigint: true });
      if (!before.isFile() || before.size !== BigInt(asset.byteLength))
        throw Error(`素材内容已改变：${asset.originalName}`);
      const key = stamp(before);
      // Filesystems without useful identity/change stamps cannot use this shortcut.
      const cacheable = before.ino !== 0n && before.ctimeNs > 0n && before.mtimeNs > 0n;
      const known = cacheable && this.verified.get(key) === asset.sha256;
      const bytes = read ? await handle.readFile() : undefined;
      if (!known) {
        const hash = createHash('sha256');
        if (bytes) hash.update(bytes);
        else {
          for await (const chunk of handle.createReadStream({ autoClose: false }))
            hash.update(chunk);
        }
        if (hash.digest('hex') !== asset.sha256)
          throw Error(`素材内容已改变：${asset.originalName}`);
      }
      if (stamp(await handle.stat({ bigint: true })) !== key)
        throw Error(`素材在读取时发生变化：${asset.originalName}`);
      // Recheck the name as well: an external replacement may leave the open handle intact.
      if (stamp(await fs.stat(file, { bigint: true })) !== key)
        throw Error(`素材在读取时被替换：${asset.originalName}`);
      if (cacheable) {
        if (this.verified.size >= 8192) this.verified.delete(this.verified.keys().next().value!);
        this.verified.set(key, asset.sha256);
      }
      return bytes;
    } finally {
      await handle.close();
    }
  }

  clear(): void {
    this.verified.clear();
  }
}
