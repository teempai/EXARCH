import { PairingFrameSchema, type PairingFrame } from "../../protocol/src/index.js";
import { ApplicationFrameDecoder, sendApplicationFrame } from "./application-protocol.js";
import type { NoiseChannel } from "./noise-channel.js";

export class PairingWire {
  private readonly decoder = new ApplicationFrameDecoder();
  private readonly iterator: AsyncIterator<Uint8Array>;
  private readonly queued: PairingFrame[] = [];

  constructor(private readonly channel: NoiseChannel) {
    this.iterator = channel.frames()[Symbol.asyncIterator]();
  }

  send(frame: PairingFrame): void {
    sendApplicationFrame(this.channel, PairingFrameSchema.parse(frame));
  }

  async receive(): Promise<PairingFrame> {
    while (this.queued.length === 0) {
      const next = await this.iterator.next();
      if (next.done) {
        this.decoder.finish();
        throw new Error("Pairing connection closed before completion");
      }
      for (const frame of this.decoder.push(next.value)) {
        this.queued.push(PairingFrameSchema.parse(frame));
      }
    }
    return this.queued.shift()!;
  }
}
