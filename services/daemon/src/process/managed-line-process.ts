import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";

export interface ManagedLineProcessOptions {
  executable: string;
  args?: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  maxLineBytes?: number;
  maxStderrBytes?: number;
}

export interface ProcessExit {
  code: number | null;
  signal: NodeJS.Signals | null;
}

const DEFAULT_MAX_LINE_BYTES = 4 * 1024 * 1024;
const DEFAULT_MAX_STDERR_BYTES = 64 * 1024;

/**
 * A shell-free, bounded, newline transport for provider processes.
 * Provider prompts must be sent with writeLine and never placed in args.
 */
export class ManagedLineProcess {
  private child: ChildProcessWithoutNullStreams | null = null;
  private readonly events = new EventEmitter();
  private stdoutChunks: Buffer[] = [];
  private stdoutBytes = 0;
  private stderrTail = Buffer.alloc(0);
  private exitPromise: Promise<ProcessExit> | null = null;

  constructor(private readonly options: ManagedLineProcessOptions) {
    this.events.setMaxListeners(100);
  }

  get pid(): number | null {
    return this.child?.pid ?? null;
  }

  get running(): boolean {
    return this.child !== null && this.child.exitCode === null && !this.child.killed;
  }

  get stderr(): string {
    return this.stderrTail.toString("utf8");
  }

  start(): Promise<void> {
    if (this.running) return Promise.resolve();
    if (this.child !== null) throw new Error("Provider process cannot be restarted after exit");

    const child = spawn(this.options.executable, this.options.args ?? [], {
      cwd: this.options.cwd,
      env: this.options.env ?? process.env,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"]
    });
    this.child = child;
    this.exitPromise = new Promise((resolve) => {
      child.once("exit", (code, signal) => {
        const exit = { code, signal };
        this.events.emit("exit", exit);
        resolve(exit);
      });
    });

    child.stdout.on("data", (chunk: Buffer) => this.consumeStdout(chunk));
    child.stderr.on("data", (chunk: Buffer) => this.consumeStderr(chunk));
    child.stdin.on("error", (error) => this.events.emit("transportError", error));

    return new Promise((resolve, reject) => {
      const onSpawn = () => {
        cleanup();
        resolve();
      };
      const onError = (error: Error) => {
        cleanup();
        if (this.child === child) {
          this.child = null;
          this.exitPromise = null;
        }
        reject(error);
      };
      const cleanup = () => {
        child.off("spawn", onSpawn);
        child.off("error", onError);
      };
      child.once("spawn", onSpawn);
      child.once("error", onError);
    });
  }

  onLine(listener: (line: string) => void): () => void {
    this.events.on("line", listener);
    return () => this.events.off("line", listener);
  }

  onExit(listener: (exit: ProcessExit) => void): () => void {
    this.events.on("exit", listener);
    return () => this.events.off("exit", listener);
  }

  onTransportError(listener: (error: Error) => void): () => void {
    this.events.on("transportError", listener);
    return () => this.events.off("transportError", listener);
  }

  writeLine(value: string): Promise<void> {
    const child = this.child;
    if (child === null || !this.running) return Promise.reject(new Error("Provider process is not running"));
    if (Buffer.byteLength(value, "utf8") > (this.options.maxLineBytes ?? DEFAULT_MAX_LINE_BYTES)) {
      return Promise.reject(new Error("Provider input exceeded the configured line limit"));
    }
    return new Promise((resolve, reject) => {
      child.stdin.write(`${value}\n`, "utf8", (error) => (error ? reject(error) : resolve()));
    });
  }

  async terminate(graceMs = 1_500): Promise<ProcessExit> {
    const child = this.child;
    if (child === null || this.exitPromise === null) return { code: null, signal: null };
    if (child.exitCode !== null || child.signalCode !== null) return this.exitPromise;

    child.kill("SIGINT");
    let timer: NodeJS.Timeout | undefined;
    const graceful = await Promise.race([
      this.exitPromise.then((exit) => ({ exit, timedOut: false as const })),
      new Promise<{ timedOut: true }>((resolve) => {
        timer = setTimeout(() => resolve({ timedOut: true }), graceMs);
        timer.unref?.();
      })
    ]);
    if (timer !== undefined) clearTimeout(timer);
    if (!graceful.timedOut) return graceful.exit;

    child.kill("SIGTERM");
    const terminated = await Promise.race([
      this.exitPromise.then((exit) => ({ exit, timedOut: false as const })),
      new Promise<{ timedOut: true }>((resolve) => {
        timer = setTimeout(() => resolve({ timedOut: true }), graceMs);
        timer.unref?.();
      })
    ]);
    if (timer !== undefined) clearTimeout(timer);
    if (!terminated.timedOut) return terminated.exit;

    child.kill("SIGKILL");
    return this.exitPromise;
  }

  private consumeStdout(chunk: Buffer): void {
    const limit = this.options.maxLineBytes ?? DEFAULT_MAX_LINE_BYTES;
    let offset = 0;
    while (offset < chunk.byteLength) {
      const newline = chunk.indexOf(0x0a, offset);
      const end = newline < 0 ? chunk.byteLength : newline;
      if (end > offset) {
        const segment = chunk.subarray(offset, end);
        this.stdoutChunks.push(segment);
        this.stdoutBytes += segment.byteLength;
      }
      if (this.stdoutBytes > limit) {
        this.failClosed("Provider output exceeded the configured line limit");
        return;
      }
      if (newline < 0) return;
      const bytes = this.stdoutChunks.length === 1
        ? this.stdoutChunks[0]!
        : Buffer.concat(this.stdoutChunks, this.stdoutBytes);
      const line = bytes.toString("utf8").replace(/\r$/, "");
      this.stdoutChunks = [];
      this.stdoutBytes = 0;
      this.events.emit("line", line);
      offset = newline + 1;
    }
  }

  private consumeStderr(chunk: Buffer): void {
    const max = this.options.maxStderrBytes ?? DEFAULT_MAX_STDERR_BYTES;
    this.stderrTail = Buffer.concat([this.stderrTail, chunk]).subarray(-max);
  }

  private failClosed(message: string): void {
    const error = new Error(message);
    this.events.emit("transportError", error);
    this.child?.kill("SIGKILL");
  }
}
