/**
 * Docker's multiplexed stream (non-TTY attach/exec): frames of [stream type, 0, 0, 0, uint32 BE size] + payload.
 * Type 0 stdin, 1 stdout, 2 stderr, 3 systemerr (a daemon error, e.g. the command could not start). Payload bytes are
 * emitted as they arrive, so a large frame is never buffered whole; a split anywhere (even inside the header) is fine.
 */
export type StreamType = 0 | 1 | 2 | 3;

export class DockerDemuxer {
  private header = Buffer.alloc(8);
  private headerLen = 0;
  private remaining = 0;
  private type: StreamType = 1;
  private readonly onData: (type: StreamType, data: Buffer) => void;

  constructor(onData: (type: StreamType, data: Buffer) => void) {
    this.onData = onData;
  }

  push(chunk: Buffer): void {
    let i = 0;
    while (i < chunk.length) {
      if (this.remaining === 0) {
        const take = Math.min(8 - this.headerLen, chunk.length - i);
        chunk.copy(this.header, this.headerLen, i, i + take);
        this.headerLen += take;
        i += take;
        if (this.headerLen < 8) return;
        const type = this.header[0];
        if (type > 3) throw new Error(`Unexpected Docker stream type ${type}`);
        this.type = type as StreamType;
        this.remaining = this.header.readUInt32BE(4);
        this.headerLen = 0;
        continue;
      }
      const take = Math.min(this.remaining, chunk.length - i);
      this.onData(this.type, chunk.subarray(i, i + take));
      this.remaining -= take;
      i += take;
    }
  }

  /** True when the stream ended on a frame boundary. */
  get clean(): boolean {
    return this.headerLen === 0 && this.remaining === 0;
  }
}

/** Builds one frame (for tests and fakes). */
export function dockerFrame(type: StreamType, payload: Buffer | string): Buffer {
  const data = typeof payload === "string" ? Buffer.from(payload) : payload;
  const header = Buffer.alloc(8);
  header[0] = type;
  header.writeUInt32BE(data.length, 4);
  return Buffer.concat([header, data]);
}
