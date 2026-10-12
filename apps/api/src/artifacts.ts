import { open, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
import { resolve, sep } from 'node:path';

export async function readBoundedArtifact(file: string, root: string, maxBytes = 2 * 1024 * 1024): Promise<Buffer> {
  const [realRoot, realFile] = await Promise.all([realpath(resolve(root)), realpath(resolve(file))]);
  if (!realFile.startsWith(realRoot + sep)) throw new Error('Artifact outside configured directory');
  const handle = await open(realFile, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stats = await handle.stat();
    if (!stats.isFile() || stats.size > maxBytes) throw new Error('Artifact limit or unsupported file');
    const bytes = Buffer.alloc(Math.min(stats.size + 1, maxBytes + 1));
    let size = 0;
    while (size < bytes.length) {
      const { bytesRead } = await handle.read(bytes, size, bytes.length - size, size);
      if (!bytesRead) break; size += bytesRead;
    }
    if (size > stats.size || size > maxBytes) throw new Error('Artifact changed or exceeds byte limit');
    return bytes.subarray(0, size);
  } finally { await handle.close(); }
}
