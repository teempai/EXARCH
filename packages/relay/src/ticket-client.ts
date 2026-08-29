import { z } from "zod";
import { assertRelayUrl } from "./relay-url.js";

const TicketResponseSchema = z
  .object({
    routingId: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
    role: z.enum(["host", "device"]),
    ticket: z.string().min(32).max(4096)
  })
  .strict();

export type RelayConnectionTicket = z.infer<typeof TicketResponseSchema>;

export async function requestRelayTicket(
  relayWebSocketUrl: string,
  accessToken: string,
  expected: { routingId: string; role: "host" | "device" },
  request: typeof fetch = fetch
): Promise<RelayConnectionTicket> {
  if (accessToken.length < 32 || accessToken.length > 4096) throw new Error("Relay access token is invalid");
  const endpoint = ticketEndpoint(relayWebSocketUrl);
  const response = await request(endpoint, {
    method: "POST",
    headers: { authorization: `Bearer ${accessToken}` },
    redirect: "error",
    signal: AbortSignal.timeout(10_000)
  });
  if (response.status !== 201) throw new Error(`Relay ticket request failed with status ${response.status}`);
  const contentLength = Number(response.headers.get("content-length") ?? "0");
  if (Number.isFinite(contentLength) && contentLength > 8192) {
    throw new Error("Relay ticket response exceeds its limit");
  }
  const raw = await response.text();
  if (Buffer.byteLength(raw, "utf8") > 8192) throw new Error("Relay ticket response exceeds its limit");
  const value = TicketResponseSchema.parse(JSON.parse(raw) as unknown);
  if (value.routingId !== expected.routingId || value.role !== expected.role) {
    throw new Error("Relay ticket scope does not match the configured route");
  }
  return value;
}

function ticketEndpoint(relayWebSocketUrl: string): URL {
  // Validate before the access token is put on the wire, not after.
  const url = assertRelayUrl(relayWebSocketUrl);
  url.protocol = url.protocol === "wss:" ? "https:" : "http:";
  url.pathname = "/v1/tickets";
  return url;
}
