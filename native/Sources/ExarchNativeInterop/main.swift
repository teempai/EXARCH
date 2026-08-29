import CryptoKit
import Foundation
import ExarchFoundation

private struct Configuration: Decodable {
    let relayWebSocketURL: URL?
    let routingID: String?
    let deviceAccessToken: String?
    let expectedHostPeerID: String?
    let invitation: PairingInvitation?
}

private struct Hello: Encodable {
    let deviceID: String
    let transportPeerID: String
    let signingPublicKey: String
    let approvalPublicKey: String
}

private struct Result: Encodable {
    let providerCount: Int
    let providers: [String]
}

private final class EphemeralStore: SecureValueStore, @unchecked Sendable {
    private let lock = NSLock()
    private var values: [String: Data] = [:]

    func read(account: String) throws -> Data? { lock.withLock { values[account] } }
    func write(_ data: Data, account: String) throws { lock.withLock { values[account] = data } }
    func delete(account: String) throws { _ = lock.withLock { values.removeValue(forKey: account) } }
}

@main
enum InteropMain {
    static func main() async {
        do {
            let deviceID = "device_native_interop"
            let identity = try LibP2PIdentity()
            let signer = SoftwareP256Signer()
            let approvalSigner = SoftwareP256Signer()
            try writeLine(Hello(
                deviceID: deviceID,
                transportPeerID: identity.peerID,
                signingPublicKey: signer.encodedPublicKey,
                approvalPublicKey: approvalSigner.encodedPublicKey
            ))

            guard let line = readLine(), let input = line.data(using: .utf8) else {
                throw ExarchError.invalidPayload("Missing interoperability configuration")
            }
            let configuration = try JSONDecoder().decode(Configuration.self, from: input)
            let store = EphemeralStore()
            try store.write(identity.rawPrivateKey, account: "libp2p.ed25519")
            let paired: PairedLaptop
            if let invitation = configuration.invitation {
                paired = try await PairingClient(
                    requestSigner: signer,
                    approvalSigner: approvalSigner,
                    transportIdentity: identity
                ).pair(
                    invitation: invitation,
                    deviceID: deviceID,
                    displayName: "Swift interoperability client",
                    confirmSAS: { _ in true }
                )
            } else {
                guard let relayWebSocketURL = configuration.relayWebSocketURL,
                      let routingID = configuration.routingID,
                      let deviceAccessToken = configuration.deviceAccessToken,
                      let expectedHostPeerID = configuration.expectedHostPeerID
                else { throw ExarchError.invalidPayload("Missing direct route configuration") }
                paired = PairedLaptop(
                    deviceID: deviceID,
                    route: RelayRouteConfiguration(
                        relayWebSocketURL: relayWebSocketURL,
                        routingID: routingID,
                        accessToken: deviceAccessToken,
                        expectedHostPeerID: expectedHostPeerID
                    ),
                    transcriptHash: "direct-test-route"
                )
            }
            let transport = NativeRelayTransport(
                route: paired.route,
                identityStore: LibP2PIdentityStore(store: store)
            )
            let client = RemoteAPIClient(
                transport: transport,
                authenticator: RequestAuthenticator(deviceId: deviceID, signer: signer)
            )
            let snapshots = try await client.get("/api/v1/providers", as: [ProviderSnapshot].self)
            try writeLine(Result(
                providerCount: snapshots.count,
                providers: snapshots.map(\.health.provider.rawValue).sorted()
            ))
            await transport.disconnect()
        } catch {
            FileHandle.standardError.write(Data("exarch-native-interop: \(error)\n".utf8))
            Foundation.exit(1)
        }
    }

    private static func writeLine<Value: Encodable>(_ value: Value) throws {
        let data = try JSONEncoder().encode(value) + Data([0x0a])
        FileHandle.standardOutput.write(data)
    }
}
