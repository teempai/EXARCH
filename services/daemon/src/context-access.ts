import { mkdir, open, unlink } from "node:fs/promises";
import { join } from "node:path";
import {
  CONTEXT_READ_OPERATIONS,
  ContextCapabilityIssuer
} from "../../../packages/core/src/index.js";
import { createId } from "../../../packages/protocol/src/index.js";

export interface TurnContextAccess {
  command: string;
  dispose(): Promise<void>;
}

/**
 * A turn is expected to finish well inside this, and the capability is revoked
 * the moment the turn ends regardless. The ceiling exists so a turn that dies
 * without running its cleanup still stops granting access reasonably soon.
 */
const DEFAULT_CAPABILITY_LIFETIME_MS = 30 * 60_000;

export class ContextAccessManager {
  constructor(
    private readonly options: {
      issuer: ContextCapabilityIssuer;
      socketPath: string;
      capabilityDirectory: string;
      nodeExecutable: string;
      cliPath: string;
      capabilityLifetimeMs?: number;
    }
  ) {}

  async create(input: {
    projectId: string;
    conversationId: string;
    turnId: string;
  }): Promise<TurnContextAccess> {
    await mkdir(this.options.capabilityDirectory, { recursive: true, mode: 0o700 });
    const capabilityId = createId("audit");
    const lifetimeMs = this.options.capabilityLifetimeMs ?? DEFAULT_CAPABILITY_LIFETIME_MS;
    const issuer = this.options.issuer;
    const grant = issuer.issueGrant({
      id: capabilityId,
      projectId: input.projectId,
      conversationId: input.conversationId,
      turnId: input.turnId,
      operations: [...CONTEXT_READ_OPERATIONS],
      lifetimeMs
    });
    const capability = grant.token;
    const expiresAt = grant.claims.expiresAt;
    const capabilityPath = join(this.options.capabilityDirectory, `${input.turnId}.capability`);
    const handle = await open(capabilityPath, "wx", 0o600);
    try {
      await handle.writeFile(`${capability}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    const globalArguments = [
      "--socket", this.options.socketPath,
      "--capability-file", capabilityPath,
      "--project-id", input.projectId,
      "--conversation-id", input.conversationId,
      "--turn-id", input.turnId,
      "--read-only"
    ];
    return {
      command: [this.options.nodeExecutable, this.options.cliPath, ...globalArguments]
        .map(shellQuote)
        .join(" "),
      async dispose() {
        // Revoke first. Unlinking the file only stops a reader that has not
        // already taken a copy of the token.
        issuer.revoke(capabilityId, expiresAt);
        try {
          await unlink(capabilityPath);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      }
    };
  }
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}
