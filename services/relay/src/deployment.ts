export function relayTrustProxy(value: string | undefined): boolean {
  if (value === undefined || value === "0" || value === "false") return false;
  if (value === "1" || value === "true") return true;
  throw new Error("EXARCH_RELAY_TRUST_PROXY must be 0, 1, false, or true");
}

export function assertRelayDeployment(host: string, trustedProxy: boolean): void {
  if (!isLoopbackHost(host) && !trustedProxy) {
    throw new Error(
      "A non-loopback relay requires EXARCH_RELAY_TRUST_PROXY=1 and a trusted TLS-terminating proxy"
    );
  }
}

function isLoopbackHost(host: string): boolean {
  const normalized = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  return normalized === "localhost" || normalized === "::1" || /^127(?:\.[0-9]{1,3}){3}$/.test(normalized);
}
