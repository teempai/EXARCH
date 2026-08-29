/**
 * One definition of an acceptable relay endpoint, shared by the connection and
 * the ticket client.
 *
 * These had drifted: `relay-connection.ts` and `ticket-client.ts` both accepted
 * `ws:` to any host, while `runtime-config.ts` and the Swift client required
 * `wss:` off loopback. The lax pair is what carries the long-lived relay access
 * token in an `Authorization` header, so it is the one that most needed the
 * strict rule.
 */
export function assertRelayUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("Relay URL is not a valid URL");
  }
  if (url.username !== "" || url.password !== "") {
    throw new Error("Relay URL must not carry credentials");
  }
  if (url.pathname !== "/v1/relay" || url.search !== "" || url.hash !== "") {
    throw new Error("Relay URL must use the exact /v1/relay endpoint");
  }
  const loopback = url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "::1" || url.hostname === "[::1]";
  if (url.protocol !== "wss:" && !(url.protocol === "ws:" && loopback)) {
    throw new Error("Relay URL must use wss, or ws only on loopback");
  }
  return url;
}
