import { createHash } from 'node:crypto';
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { join } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import type { MarketEvent } from '../domain';

export interface SegmentInfo {
  seq: number;
  file: string;
  sha256: string;
  rawFile: string | null;
  rawSha256: string | null;
  firstOrdinal: number;
  lastOrdinal: number;
  firstTime: number;
  lastTime: number;
  events: number;
  recovered: boolean;
}

export interface DatasetManifest {
  datasetId: string;
  sessionId: string | null;
  format: 'jbelford-paper-events-v1';
  createdAt: number;
  segments: SegmentInfo[];
  finalized: boolean;
}

/**
 * Append-only market recording. Normalized events (exactly what the runtime
 * consumed, with ordinals) go to `seg-N.events.jsonl`; raw venue messages go to
 * `seg-N.raw.jsonl`. Every `segmentSeconds` the open segment is gzip-compressed,
 * hashed and listed in `manifest.json` (written atomically). Events are written
 * BEFORE the runtime acts on them, and `flush()` fsyncs, so decisions and fills
 * only reference durably recorded events.
 */
export class Recorder {
  readonly dir: string;
  private manifest: DatasetManifest;
  private fd: number | null = null;
  private rawFd: number | null = null;
  private cur: { seq: number; first: number; last: number; firstTime: number; lastTime: number; n: number; openedAt: number } | null = null;
  durableOrdinal = 0;
  private pendingOrdinal = 0;
  failed: string | null = null;

  constructor(
    root: string,
    readonly datasetId: string,
    sessionId: string | null,
    private readonly segmentMs: number,
    private readonly recordRaw = true,
  ) {
    this.dir = join(root, datasetId);
    mkdirSync(this.dir, { recursive: true });
    const mp = join(this.dir, 'manifest.json');
    this.manifest = existsSync(mp)
      ? (JSON.parse(readFileSync(mp, 'utf8')) as DatasetManifest)
      : { datasetId, sessionId, format: 'jbelford-paper-events-v1', createdAt: Date.now(), segments: [], finalized: false };
    this.manifest.finalized = false;
    this.recover();
    this.writeManifest();
  }

  /** Finalize any segment left open by a crash: drop a trailing partial line, then compress and hash it. */
  private recover(): void {
    for (const f of readdirSync(this.dir).filter((x) => /^seg-\d+\.events\.jsonl$/.test(x))) {
      const seq = Number(/seg-(\d+)/.exec(f)![1]);
      const path = join(this.dir, f);
      const text = readFileSync(path, 'utf8');
      const lines = text.split('\n');
      const complete = text.endsWith('\n') ? lines.slice(0, -1) : lines.slice(0, -1); // last element is '' or a partial line
      const events = complete.filter(Boolean).map((l) => JSON.parse(l) as MarketEvent);
      writeFileSync(path, complete.length ? complete.join('\n') + '\n' : '');
      if (events.length === 0) {
        rmSync(path);
        rmSync(join(this.dir, `seg-${pad(seq)}.raw.jsonl`), { force: true });
        continue;
      }
      this.cur = {
        seq,
        first: events[0]!.ordinal,
        last: events.at(-1)!.ordinal,
        firstTime: events[0]!.receiptTime,
        lastTime: events.at(-1)!.receiptTime,
        n: events.length,
        openedAt: 0,
      };
      this.finalizeSegment(true);
    }
  }

  private open(ev: MarketEvent): void {
    const seq = (this.manifest.segments.at(-1)?.seq ?? 0) + 1;
    this.fd = openSync(join(this.dir, `seg-${pad(seq)}.events.jsonl`), 'a');
    this.rawFd = this.recordRaw ? openSync(join(this.dir, `seg-${pad(seq)}.raw.jsonl`), 'a') : null;
    this.cur = {
      seq,
      first: ev.ordinal,
      last: ev.ordinal,
      firstTime: ev.receiptTime,
      lastTime: ev.receiptTime,
      n: 0,
      openedAt: ev.receiptTime,
    };
  }

  append(ev: MarketEvent): void {
    if (this.failed) throw new Error(`recorder failed: ${this.failed}`);
    try {
      if (this.cur && this.fd !== null && ev.receiptTime - this.cur.openedAt >= this.segmentMs) this.rotate();
      if (!this.cur || this.fd === null) this.open(ev);
      writeSync(this.fd!, JSON.stringify(ev) + '\n');
      const c = this.cur!;
      c.last = ev.ordinal;
      c.lastTime = ev.receiptTime;
      c.n++;
      this.pendingOrdinal = ev.ordinal;
    } catch (e) {
      this.failed = String(e);
      throw e;
    }
  }

  appendRaw(raw: unknown, receiptTime: number, epoch: number): void {
    if (this.rawFd === null || this.failed) return;
    try {
      writeSync(this.rawFd, JSON.stringify({ receiptTime, epoch, raw }) + '\n');
    } catch (e) {
      this.failed = String(e);
    }
  }

  /** fsync the open segment; advances the durable watermark. */
  flush(): void {
    if (this.fd === null) return;
    try {
      fsyncSync(this.fd);
      if (this.rawFd !== null) fsyncSync(this.rawFd);
      this.durableOrdinal = this.pendingOrdinal;
    } catch (e) {
      this.failed = String(e);
      throw e;
    }
  }

  rotate(): void {
    if (!this.cur) return;
    this.flush();
    if (this.fd !== null) closeSync(this.fd);
    if (this.rawFd !== null) closeSync(this.rawFd);
    this.fd = null;
    this.rawFd = null;
    this.finalizeSegment(false);
  }

  private finalizeSegment(recovered: boolean): void {
    const c = this.cur!;
    const base = `seg-${pad(c.seq)}`;
    const ev = join(this.dir, `${base}.events.jsonl`);
    const gz = gzipSync(readFileSync(ev));
    writeFileSync(`${ev}.gz.tmp`, gz);
    renameSync(`${ev}.gz.tmp`, `${ev}.gz`);
    rmSync(ev);
    let rawFile: string | null = null;
    let rawSha: string | null = null;
    const raw = join(this.dir, `${base}.raw.jsonl`);
    if (existsSync(raw) && statSync(raw).size > 0) {
      const rgz = gzipSync(readFileSync(raw));
      writeFileSync(`${raw}.gz`, rgz);
      rawFile = `${base}.raw.jsonl.gz`;
      rawSha = sha(rgz);
    }
    rmSync(raw, { force: true });
    this.manifest.segments.push({
      seq: c.seq,
      file: `${base}.events.jsonl.gz`,
      sha256: sha(gz),
      rawFile,
      rawSha256: rawSha,
      firstOrdinal: c.first,
      lastOrdinal: c.last,
      firstTime: c.firstTime,
      lastTime: c.lastTime,
      events: c.n,
      recovered,
    });
    this.cur = null;
    this.writeManifest();
  }

  private writeManifest(): void {
    const p = join(this.dir, 'manifest.json');
    writeFileSync(`${p}.tmp`, JSON.stringify(this.manifest, null, 2));
    renameSync(`${p}.tmp`, p);
  }

  close(): DatasetManifest {
    if (this.cur) this.rotate();
    this.manifest.finalized = true;
    this.writeManifest();
    return this.manifest;
  }
}

function pad(n: number): string {
  return String(n).padStart(6, '0');
}

function sha(b: Buffer | string): string {
  return createHash('sha256').update(b).digest('hex');
}

export function readManifest(datasetDir: string): DatasetManifest {
  return JSON.parse(readFileSync(join(datasetDir, 'manifest.json'), 'utf8')) as DatasetManifest;
}

/** Read every event of a dataset in ordinal order, verifying segment hashes. */
export function* readDataset(datasetDir: string): Generator<MarketEvent> {
  const m = readManifest(datasetDir);
  let last = 0;
  for (const s of [...m.segments].sort((a, b) => a.seq - b.seq)) {
    const buf = readFileSync(join(datasetDir, s.file));
    if (sha(buf) !== s.sha256) throw new Error(`segment ${s.file} hash mismatch`);
    for (const line of gunzipSync(buf).toString('utf8').split('\n')) {
      if (!line) continue;
      const e = JSON.parse(line) as MarketEvent;
      if (e.ordinal <= last) throw new Error(`non-increasing ordinal ${e.ordinal} after ${last} in ${s.file}`);
      last = e.ordinal;
      yield e;
    }
  }
}
