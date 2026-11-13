import fs from "node:fs/promises";
import path from "node:path";

export const LEARNINGS_INDEX_RELATIVE_PATH = "learnings/INDEX.md";
export const LEARNINGS_INDEX_MAX_BYTES = 4096;

const NEWLINE_BYTE = 0x0a;

export type LearningsIndex = { text: string; truncated: boolean };

function cutAtLastWholeLine(buffer: Buffer): Buffer {
  const lastNewline = buffer.subarray(0, LEARNINGS_INDEX_MAX_BYTES).lastIndexOf(NEWLINE_BYTE);
  return buffer.subarray(0, lastNewline + 1);
}

export type ByteReadable = {
  read(buffer: Buffer, offset: number, length: number, position: number): Promise<{ bytesRead: number }>;
};

export async function readUpToBytes(source: ByteReadable, maxBytes: number): Promise<Buffer> {
  const buffer = Buffer.alloc(maxBytes);
  let total = 0;
  while (total < maxBytes) {
    const { bytesRead } = await source.read(buffer, total, maxBytes - total, total);
    if (bytesRead === 0) break;
    total += bytesRead;
  }
  return buffer.subarray(0, total);
}

async function readCappedBytes(filePath: string): Promise<Buffer | null> {
  const handle = await fs.open(filePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    if (!(await handle.stat()).isFile()) return null;
    return await readUpToBytes(handle, LEARNINGS_INDEX_MAX_BYTES + 1);
  } finally {
    await handle.close();
  }
}

function isInside(realRoot: string, realPath: string): boolean {
  return realPath.startsWith(`${realRoot}${path.sep}`);
}

function decodeUtf8Strictly(bytes: Buffer): string | null {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

export function learningsIndexFromBytes(bytes: Buffer): LearningsIndex | null {
  const truncated = bytes.length > LEARNINGS_INDEX_MAX_BYTES;
  const text = decodeUtf8Strictly(truncated ? cutAtLastWholeLine(bytes) : bytes);
  if (text === null) return null;
  if (!truncated && text.trim() === "") return null;
  return { text, truncated };
}

export async function readLearningsIndex(localRoot: string): Promise<LearningsIndex | null> {
  const indexPath = path.join(localRoot, LEARNINGS_INDEX_RELATIVE_PATH);
  let bytes: Buffer | null;
  try {
    if (!(await fs.lstat(indexPath)).isFile()) return null;
    const [realRoot, realIndexPath] = await Promise.all([fs.realpath(localRoot), fs.realpath(indexPath)]);
    if (!isInside(realRoot, realIndexPath)) return null;
    bytes = await readCappedBytes(indexPath);
  } catch {
    return null;
  }
  return bytes ? learningsIndexFromBytes(bytes) : null;
}

export function formatLearningsIndexGuidance(index: LearningsIndex, today: Date): string {
  const todayIsoDate = today.toISOString().slice(0, 10);
  const sections = [
    `Learnings index (${LEARNINGS_INDEX_RELATIVE_PATH}), today is ${todayIsoDate}:`,
    "An entry whose last_confirmed is more than 90 days before today must be verified against current evidence before you apply it.",
    index.text,
  ];
  if (index.truncated) {
    sections.push(
      `The index was truncated at ${LEARNINGS_INDEX_MAX_BYTES} bytes. Consolidate or retire entries in ${LEARNINGS_INDEX_RELATIVE_PATH}.`,
    );
  }
  return sections.join("\n\n");
}
