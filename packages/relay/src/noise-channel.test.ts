import { generateKeyPair } from "@libp2p/crypto/keys";
import { defaultLogger } from "@libp2p/logger";
import { AbstractMessageStream, type SendResult } from "@libp2p/utils";
import { describe, expect, it } from "vitest";
import type { Uint8ArrayList } from "uint8arraylist";
import {
  MAX_ENCRYPTED_APPLICATION_FRAME_BYTES,
  NoiseEndpoint
} from "./noise-channel.js";

describe("NoiseEndpoint", () => {
  it("mutually authenticates pinned transport identities and hides application plaintext", async () => {
    const alice = new NoiseEndpoint(await generateKeyPair("Ed25519"));
    const bob = new NoiseEndpoint(await generateKeyPair("Ed25519"));
    const pair = memoryPair();
    const [aliceChannel, bobChannel] = await Promise.all([
      alice.connect(pair.outbound, bob.peerId),
      bob.accept(pair.inbound, alice.peerId)
    ]);
    const secret = Buffer.from("private canonical message that relay must not read", "utf8");
    const received = bobChannel.frames()[Symbol.asyncIterator]().next();
    aliceChannel.send(secret);
    expect(Buffer.from((await received).value as Uint8Array)).toEqual(secret);
    expect(Buffer.concat(pair.captured).includes(secret)).toBe(false);
    await Promise.all([aliceChannel.close(), bobChannel.close()]);
  });

  it("rejects a substituted identity and a modified handshake", async () => {
    const alice = new NoiseEndpoint(await generateKeyPair("Ed25519"));
    const bob = new NoiseEndpoint(await generateKeyPair("Ed25519"));
    const mallory = new NoiseEndpoint(await generateKeyPair("Ed25519"));
    const substituted = memoryPair();
    const identityTimeout = AbortSignal.timeout(500);
    const identityResults = await Promise.allSettled([
      alice.connect(substituted.outbound, bob.peerId, identityTimeout),
      mallory.accept(substituted.inbound, alice.peerId, identityTimeout)
    ]);
    expect(identityResults.some((result) => result.status === "rejected")).toBe(true);

    const tampered = memoryPair((bytes, direction, index) => {
      if (direction === "outbound" && index === 0) {
        const changed = Uint8Array.from(bytes);
        const last = changed.length - 1;
        if (last >= 0) changed[last] = (changed[last] ?? 0) ^ 1;
        return changed;
      }
      return bytes;
    });
    const tamperTimeout = AbortSignal.timeout(500);
    const tamperResults = await Promise.allSettled([
      alice.connect(tampered.outbound, bob.peerId, tamperTimeout),
      bob.accept(tampered.inbound, alice.peerId, tamperTimeout)
    ]);
    expect(tamperResults.some((result) => result.status === "rejected")).toBe(true);
  });

  it("enforces the plaintext frame boundary before encryption", async () => {
    const alice = new NoiseEndpoint(await generateKeyPair("Ed25519"));
    const bob = new NoiseEndpoint(await generateKeyPair("Ed25519"));
    const pair = memoryPair();
    const [aliceChannel, bobChannel] = await Promise.all([
      alice.connect(pair.outbound, bob.peerId),
      bob.accept(pair.inbound, alice.peerId)
    ]);
    expect(() => aliceChannel.send(Buffer.alloc(0))).toThrow(/size limit/);
    expect(() => aliceChannel.send(Buffer.alloc(MAX_ENCRYPTED_APPLICATION_FRAME_BYTES + 1))).toThrow(
      /size limit/
    );
    await Promise.all([aliceChannel.close(), bobChannel.close()]);
  });
});

type Direction = "outbound" | "inbound";
type Transform = (bytes: Uint8Array, direction: Direction, index: number) => Uint8Array;

class MemoryStream extends AbstractMessageStream {
  peer: MemoryStream | null = null;
  sent = 0;

  constructor(
    direction: Direction,
    private readonly captured: Buffer[],
    private readonly transform?: Transform
  ) {
    super({ direction, log: defaultLogger().forComponent(`exarch:test:${direction}`) });
  }

  sendData(data: Uint8ArrayList): SendResult {
    const original = data.subarray();
    this.captured.push(Buffer.from(original));
    const bytes = this.transform?.(original, this.direction, this.sent) ?? original;
    this.sent += 1;
    queueMicrotask(() => this.peer?.onData(bytes));
    return { sentBytes: original.byteLength, canSendMore: true };
  }

  sendReset(error: Error): void {
    this.peer?.onTransportClosed(error);
  }

  sendPause(): void {}

  sendResume(): void {}

  async close(): Promise<void> {
    this.onTransportClosed();
    this.peer?.onTransportClosed();
  }
}

function memoryPair(transform?: Transform): {
  outbound: MemoryStream;
  inbound: MemoryStream;
  captured: Buffer[];
} {
  const captured: Buffer[] = [];
  const outbound = new MemoryStream("outbound", captured, transform);
  const inbound = new MemoryStream("inbound", captured, transform);
  outbound.peer = inbound;
  inbound.peer = outbound;
  return { outbound, inbound, captured };
}
