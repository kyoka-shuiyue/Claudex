// 读 JSONL 会话记录：只读开头或结尾，文件可能有几十 MB。
import fs from 'node:fs';
import path from 'node:path';

function parse(line) {
  try { return JSON.parse(line); } catch { return null; }
}

// 第一条记录（Codex 的 session_meta 可能很长，最多读 4MB）
export function readFirstRecord(file, maxBytes = 4 * 1024 * 1024) {
  const fd = fs.openSync(file, 'r');
  try {
    const chunks = [];
    const buf = Buffer.alloc(64 * 1024);
    let pos = 0;
    while (pos < maxBytes) {
      const n = fs.readSync(fd, buf, 0, buf.length, pos);
      if (n <= 0) break;
      const nl = buf.subarray(0, n).indexOf(10);
      if (nl >= 0) { chunks.push(Buffer.from(buf.subarray(0, nl))); break; }
      chunks.push(Buffer.from(buf.subarray(0, n)));
      pos += n;
    }
    return parse(Buffer.concat(chunks).toString('utf8'));
  } finally { fs.closeSync(fd); }
}

/**
 * 从结尾往前读记录，直到 enough(records) 返回 true 或读到上限。
 * 返回按文件顺序排列的完整记录（丢掉开头可能被截断的那一行）。
 */
export function readTailRecords(file, { start = 256 * 1024, max = 8 * 1024 * 1024, enough = () => false } = {}) {
  const size = fs.statSync(file).size;
  let span = Math.min(start, size);
  for (;;) {
    const fd = fs.openSync(file, 'r');
    let text;
    try {
      const buf = Buffer.alloc(span);
      fs.readSync(fd, buf, 0, span, size - span);
      text = buf.toString('utf8');
    } finally { fs.closeSync(fd); }
    let lines = text.split('\n');
    if (span < size) lines = lines.slice(1);
    const records = lines.filter(l => l.trim()).map(parse).filter(Boolean);
    if (span >= size || span >= max || enough(records)) return records;
    span = Math.min(span * 4, size, max);
  }
}

export function readAllLines(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter(l => l.trim()).map(parse).filter(Boolean);
}

// 从末尾分块寻找指定类型的最后一条记录，不受 readTailRecords 的 8MB 上限影响。
// 字节拼接保留跨块的 UTF-8 字符，内存只保留尚未读完整的一行。
export function readLastRecordOfType(file, type) {
  const fd = fs.openSync(file, 'r');
  const marker = Buffer.from(JSON.stringify(type));
  let pos = fs.fstatSync(fd).size;
  let carry = Buffer.alloc(0);
  const matching = line => {
    if (!line.includes(marker)) return null;
    const record = parse(line.toString('utf8'));
    return record?.type === type ? record : null;
  };
  try {
    while (pos > 0) {
      const size = Math.min(pos, 256 * 1024);
      pos -= size;
      const chunk = Buffer.alloc(size);
      fs.readSync(fd, chunk, 0, size, pos);
      const data = Buffer.concat([chunk, carry]);
      let end = data.length;
      // carry 中已确认没有换行，只扫描这次新读入的部分。
      for (let i = chunk.length - 1; i >= 0; i--) {
        if (data[i] !== 10) continue;
        const record = matching(data.subarray(i + 1, end));
        if (record) return record;
        end = i;
      }
      carry = Buffer.from(data.subarray(0, end));
    }
    return matching(carry);
  } finally { fs.closeSync(fd); }
}

// 递归找出最近修改过的 .jsonl 文件，按修改时间倒序
export function recentJsonl(dir, sinceMs, { recursive = true, match = () => true } = {}) {
  const out = [];
  const walk = d => {
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { if (recursive) walk(p); continue; }
      if (!e.name.endsWith('.jsonl') || !match(e.name, p)) continue;
      const st = fs.statSync(p);
      if (st.mtimeMs >= sinceMs) out.push({ file: p, mtimeMs: st.mtimeMs });
    }
  };
  walk(dir);
  return out.sort((a, b) => b.mtimeMs - a.mtimeMs);
}
