/**
 * Bounded capture of one output stream: the first `headBytes` are forwarded live, after that only the last
 * `tailBytes` are kept (the end of the output usually holds the error). Memory stays bounded however much a command
 * prints, and Docker's socket is always drained at full speed (no back-pressure reaches it).
 */
export class StreamCapture {
  private sent = 0;
  private tail: Buffer[] = [];
  private tailLen = 0;
  private dropped = 0;
  total = 0;
  private readonly headBytes: number;
  private readonly tailBytes: number;
  private readonly emit: (chunk: Buffer) => void;

  constructor(headBytes: number, tailBytes: number, emit: (chunk: Buffer) => void) {
    this.headBytes = headBytes;
    this.tailBytes = tailBytes;
    this.emit = emit;
  }

  push(chunk: Buffer): void {
    this.total += chunk.length;
    if (this.sent < this.headBytes) {
      const live = chunk.subarray(0, this.headBytes - this.sent);
      this.sent += live.length;
      this.emit(live);
      chunk = chunk.subarray(live.length);
      if (!chunk.length) return;
    }
    this.tail.push(chunk);
    this.tailLen += chunk.length;
    while (this.tailLen > this.tailBytes) {
      const over = this.tailLen - this.tailBytes;
      const first = this.tail[0];
      if (first.length <= over) {
        this.tail.shift();
        this.tailLen -= first.length;
        this.dropped += first.length;
      } else {
        this.tail[0] = first.subarray(over);
        this.tailLen -= over;
        this.dropped += over;
      }
    }
  }

  /** What was dropped between head and tail, and the kept tail. */
  finish(): { dropped: number; tail: Buffer } {
    const tail = Buffer.concat(this.tail);
    this.tail = [];
    this.tailLen = 0;
    return { dropped: this.dropped, tail };
  }
}
