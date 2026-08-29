import { noise } from "@chainsafe/libp2p-noise";
import type {
  MessageStream,
  PeerId,
  PrivateKey,
  SecuredConnection,
  Upgrader
} from "@libp2p/interface";
import { defaultLogger } from "@libp2p/logger";
import { peerIdFromPrivateKey } from "@libp2p/peer-id";

export const RELAY_NOISE_PROLOGUE = Buffer.from(
  "exarch/relay/noise-xx/1",
  "utf8"
);
export const MAX_ENCRYPTED_APPLICATION_FRAME_BYTES = 60 * 1024;

const noMuxerUpgrader = {
  getStreamMuxers: () => new Map()
} as unknown as Upgrader;

export class NoiseEndpoint {
  readonly peerId: PeerId;
  private readonly encrypter;

  constructor(readonly identityKey: PrivateKey) {
    if (identityKey.type !== "Ed25519") {
      throw new Error("Relay Noise identity must be an Ed25519 libp2p identity");
    }
    this.peerId = peerIdFromPrivateKey(identityKey);
    this.encrypter = noise({ prologueBytes: RELAY_NOISE_PROLOGUE })({
      peerId: this.peerId,
      privateKey: identityKey,
      logger: defaultLogger(),
      upgrader: noMuxerUpgrader
    });
  }

  async connect(
    transport: MessageStream,
    expectedRemote?: PeerId,
    signal?: AbortSignal
  ): Promise<NoiseChannel> {
    const secured = await this.encrypter.secureOutbound(transport, {
      skipStreamMuxerNegotiation: true,
      ...(expectedRemote === undefined ? {} : { remotePeer: expectedRemote }),
      ...(signal === undefined ? {} : { signal })
    });
    return new NoiseChannel(secured, this.peerId);
  }

  async accept(
    transport: MessageStream,
    expectedRemote?: PeerId,
    signal?: AbortSignal
  ): Promise<NoiseChannel> {
    const secured = await this.encrypter.secureInbound(transport, {
      skipStreamMuxerNegotiation: true,
      ...(expectedRemote === undefined ? {} : { remotePeer: expectedRemote }),
      ...(signal === undefined ? {} : { signal })
    });
    return new NoiseChannel(secured, this.peerId);
  }
}

export class NoiseChannel {
  readonly remotePeer: PeerId;
  readonly localPeer: PeerId;
  private readonly connection: MessageStream;

  constructor(secured: SecuredConnection, localPeer?: PeerId) {
    this.connection = secured.connection;
    this.remotePeer = secured.remotePeer;
    if (localPeer === undefined) throw new Error("Encrypted channel local identity is missing");
    this.localPeer = localPeer;
  }

  send(frame: Uint8Array): void {
    if (frame.byteLength === 0 || frame.byteLength > MAX_ENCRYPTED_APPLICATION_FRAME_BYTES) {
      throw new Error("Application frame is outside the encrypted channel size limit");
    }
    if (!this.connection.send(frame)) {
      throw new Error("Encrypted channel backpressure limit reached");
    }
  }

  async *frames(): AsyncIterable<Uint8Array> {
    for await (const frame of this.connection) {
      const bytes = frame instanceof Uint8Array ? frame : frame.subarray();
      if (bytes.byteLength === 0 || bytes.byteLength > MAX_ENCRYPTED_APPLICATION_FRAME_BYTES) {
        this.connection.abort(new Error("Decrypted application frame exceeded its limit"));
        throw new Error("Decrypted application frame is outside the allowed size limit");
      }
      yield bytes;
    }
  }

  close(): Promise<void> {
    return this.connection.close();
  }
}
