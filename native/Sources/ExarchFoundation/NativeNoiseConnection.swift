import Crypto
import Foundation
import Noise

public struct RelayRouteConfiguration: Codable, Equatable, Sendable {
    public let relayWebSocketURL: URL
    public let routingID: String
    public let accessToken: String
    public let expectedHostPeerID: String

    public init(relayWebSocketURL: URL, routingID: String, accessToken: String, expectedHostPeerID: String) {
        self.relayWebSocketURL = relayWebSocketURL
        self.routingID = routingID
        self.accessToken = accessToken
        self.expectedHostPeerID = expectedHostPeerID
    }
}

public actor NativeNoiseConnection {
    public static let prologue = Data("exarch/relay/noise-xx/1".utf8)
    public static let maximumPlaintextFrameBytes = 60 * 1024
    private static let maximumWireMessageBytes = 70 * 1024

    private let socket: URLSessionWebSocketTask
    private let identity: LibP2PIdentity
    private let expectedHostPeerID: String
    private var wireBuffer = Data()
    private var encryptor: Noise.CipherState?
    private var decryptor: Noise.CipherState?
    private var closed = false

    private init(socket: URLSessionWebSocketTask, identity: LibP2PIdentity, expectedHostPeerID: String) {
        self.socket = socket
        self.identity = identity
        self.expectedHostPeerID = expectedHostPeerID
    }

    public static func connect(
        route: RelayRouteConfiguration,
        ticket: String,
        identity: LibP2PIdentity,
        session: URLSession = .shared
    ) async throws -> NativeNoiseConnection {
        try validateRelayURL(route.relayWebSocketURL)
        guard route.routingID.range(of: #"^[A-Za-z0-9_-]{43}$"#, options: .regularExpression) != nil,
              ticket.count >= 32,
              ticket.count <= 4096
        else { throw ExarchError.invalidPayload("Invalid relay registration") }

        let socket = session.webSocketTask(with: route.relayWebSocketURL)
        let connection = NativeNoiseConnection(
            socket: socket,
            identity: identity,
            expectedHostPeerID: route.expectedHostPeerID
        )
        socket.resume()
        do {
            try await connection.register(routingID: route.routingID, ticket: ticket)
            try await connection.handshake()
            return connection
        } catch {
            socket.cancel(with: .policyViolation, reason: nil)
            throw error
        }
    }

    public func send(_ plaintext: Data) async throws {
        guard !closed, let encryptor else { throw ExarchError.transportClosed }
        guard !plaintext.isEmpty, plaintext.count <= Self.maximumPlaintextFrameBytes else {
            throw ExarchError.invalidPayload("Encrypted frame is outside its size limit")
        }
        let ciphertext = try Data(encryptor.encrypt(plaintext: [UInt8](plaintext)))
        try await socket.send(.data(try Self.frame(ciphertext)))
    }

    public func receive() async throws -> Data {
        guard !closed, let decryptor else { throw ExarchError.transportClosed }
        let ciphertext = try await readRecord()
        let plaintext = try Data(decryptor.decrypt(ciphertext: [UInt8](ciphertext)))
        guard !plaintext.isEmpty, plaintext.count <= Self.maximumPlaintextFrameBytes else {
            throw ExarchError.invalidPayload("Decrypted frame is outside its size limit")
        }
        return plaintext
    }

    public func close() {
        guard !closed else { return }
        closed = true
        socket.cancel(with: .normalClosure, reason: nil)
    }

    private func register(routingID: String, ticket: String) async throws {
        let registration: [String: Any] = [
            "type": "register",
            "routingId": routingID,
            "role": "device",
            "ticket": ticket
        ]
        let data = try CanonicalJSON.encode(registration)
        try await socket.send(.string(String(decoding: data, as: UTF8.self)))
        while true {
            switch try await socket.receive() {
            case let .string(value):
                guard value.utf8.count <= 4096,
                      let object = try JSONSerialization.jsonObject(with: Data(value.utf8)) as? [String: Any],
                      let type = object["type"] as? String
                else { throw ExarchError.invalidPayload("Relay returned invalid control data") }
                if type == "ready" { return }
                if type == "counterpart.offline" { throw ExarchError.transportClosed }
                guard type == "registered" else { throw ExarchError.invalidPayload("Unexpected relay control message") }
            case .data:
                throw ExarchError.invalidPayload("Relay started the handshake before readiness")
            @unknown default:
                throw ExarchError.transportClosed
            }
        }
    }

    private func handshake() async throws {
        let staticKey = Curve25519.KeyAgreement.PrivateKey()
        let suite = Noise.CipherSuite(keyCurve: .x25519, cipher: .ChaChaPoly1305, hashFunction: .sha256)
        let config = Noise.Config(
            cipherSuite: suite,
            handshake: .XX_Initiator,
            prologue: [UInt8](Self.prologue),
            staticKeypair: staticKey
        )
        let state = try Noise.HandshakeState(config: config)

        let messageA = try state.writeMessage(payload: [])
        try await socket.send(.data(try Self.frame(Data(messageA.buffer))))

        let messageB = try state.readMessage([UInt8](try await readRecord()))
        let remoteNoiseStatic = Data(try state.peerStatic().rawRepresentation)
        _ = try LibP2PNoisePayload.decodeAndVerify(
            Data(messageB.payload),
            noiseStaticPublicKey: remoteNoiseStatic,
            expectedPeerID: expectedHostPeerID
        )

        let localPayload = try LibP2PNoisePayload.make(
            identity: identity,
            noiseStaticPublicKey: staticKey.publicKey.rawRepresentation
        )
        let messageC = try state.writeMessage(payload: [UInt8](localPayload))
        guard let outgoing = messageC.c1, let incoming = messageC.c2 else {
            throw ExarchError.authenticationFailed
        }
        try await socket.send(.data(try Self.frame(Data(messageC.buffer))))
        encryptor = outgoing
        decryptor = incoming
    }

    private func readRecord() async throws -> Data {
        while true {
            if wireBuffer.count >= 2 {
                let length = Int(wireBuffer[0]) << 8 | Int(wireBuffer[1])
                guard length > 0 else { throw ExarchError.invalidEncoding }
                if wireBuffer.count >= length + 2 {
                    let record = wireBuffer.subdata(in: 2..<(length + 2))
                    wireBuffer.removeSubrange(0..<(length + 2))
                    return record
                }
            }
            switch try await socket.receive() {
            case let .data(data):
                guard !data.isEmpty, data.count <= Self.maximumWireMessageBytes else {
                    throw ExarchError.responseTooLarge
                }
                wireBuffer.append(data)
                guard wireBuffer.count <= Self.maximumWireMessageBytes * 2 else {
                    throw ExarchError.responseTooLarge
                }
            case let .string(value):
                guard value.utf8.count <= 4096,
                      let object = try JSONSerialization.jsonObject(with: Data(value.utf8)) as? [String: Any],
                      object["type"] as? String == "counterpart.offline"
                else { throw ExarchError.invalidPayload("Unexpected relay control data") }
                throw ExarchError.transportClosed
            @unknown default:
                throw ExarchError.transportClosed
            }
        }
    }

    private static func frame(_ payload: Data) throws -> Data {
        guard !payload.isEmpty, payload.count <= UInt16.max else { throw ExarchError.responseTooLarge }
        var length = UInt16(payload.count).bigEndian
        return withUnsafeBytes(of: &length) { Data($0) } + payload
    }

    /// Shared so callers can check the endpoint before putting a credential on
    /// the wire, rather than only when the socket is opened.
    public static func validateRelayURL(_ url: URL) throws {
        guard url.user == nil,
              url.password == nil,
              url.path == "/v1/relay",
              url.query == nil,
              url.fragment == nil
        else { throw ExarchError.invalidPayload("Relay URL must use the exact /v1/relay endpoint") }
        if url.scheme == "wss" { return }
        let loopback = url.host == "127.0.0.1" || url.host == "localhost" || url.host == "::1"
        guard url.scheme == "ws", loopback else {
            throw ExarchError.invalidPayload("Remote relay connections require TLS")
        }
    }
}
