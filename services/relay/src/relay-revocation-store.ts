import { chmod, lstat, mkdir, open, readFile, rename } from "node:fs/promises";
import { dirname } from "node:path";

const ROUTING_ID = /^[A-Za-z0-9_-]{43}$/;

export interface RelayRevocationStore {
  has(routingId: string): boolean;
  add(routingId: string): Promise<void>;
}

export class MemoryRelayRevocationStore implements RelayRevocationStore {
  private readonly routes = new Set<string>();

  has(routingId: string): boolean { return this.routes.has(routingId); }
  async add(routingId: string): Promise<void> {
    validateRoutingId(routingId);
    this.routes.add(routingId);
  }
}

export class FileRelayRevocationStore implements RelayRevocationStore {
  private readonly routes: Set<string>;

  private constructor(private readonly path: string, routes: string[]) {
    this.routes = new Set(routes);
  }

  static async open(path: string): Promise<FileRelayRevocationStore> {
    if (!path.startsWith("/") || path === "/") throw new Error("Relay state path must be an absolute file path");
    let routes: string[] = [];
    try {
      const metadata = await lstat(path);
      if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error("Relay state must be a regular file");
      if ((metadata.mode & 0o077) !== 0) throw new Error("Relay state permissions must be 0600 or stricter");
      const value = JSON.parse(await readFile(path, "utf8")) as unknown;
      if (!isState(value)) throw new Error("Relay state is invalid");
      routes = value.revokedRoutingIds;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    return new FileRelayRevocationStore(path, routes);
  }

  has(routingId: string): boolean { return this.routes.has(routingId); }

  async add(routingId: string): Promise<void> {
    validateRoutingId(routingId);
    if (this.routes.has(routingId)) return;
    this.routes.add(routingId);
    try {
      await this.persist();
    } catch (error) {
      this.routes.delete(routingId);
      throw error;
    }
  }

  private async persist(): Promise<void> {
    const directory = dirname(this.path);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);
    const temporary = `${this.path}.tmp-${process.pid}`;
    const handle = await open(temporary, "w", 0o600);
    try {
      const state = {
        version: 1,
        revokedRoutingIds: [...this.routes].sort()
      };
      await handle.writeFile(`${JSON.stringify(state)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, this.path);
  }
}

function validateRoutingId(routingId: string): void {
  if (!ROUTING_ID.test(routingId)) throw new Error("Routing ID is invalid");
}

function isState(value: unknown): value is { version: 1; revokedRoutingIds: string[] } {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return record.version === 1
    && Array.isArray(record.revokedRoutingIds)
    && record.revokedRoutingIds.every((route) => typeof route === "string" && ROUTING_ID.test(route))
    && Object.keys(record).length === 2;
}
