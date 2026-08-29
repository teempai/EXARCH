import CryptoKit
import Foundation

public struct PairingInvitation: Codable, Equatable, Sendable {
    public let version: Int
    public let invitationId: String
    public let relayWebSocketUrl: String
    public let routingId: String
    public let deviceTicket: String
    public let challenge: String
    public let hostSigningPublicKey: String
    public let hostTransportPeerId: String
    public let expiresAt: String
}

public struct PairedLaptop: Codable, Equatable, Sendable {
    public let deviceID: String
    public let route: RelayRouteConfiguration
    public let transcriptHash: String

    public init(deviceID: String, route: RelayRouteConfiguration, transcriptHash: String) {
        self.deviceID = deviceID
        self.route = route
        self.transcriptHash = transcriptHash
    }
}

public struct PairingClient: Sendable {
    private let requestSigner: any P256PayloadSigner
    private let approvalSigner: any P256PayloadSigner
    private let transportIdentity: LibP2PIdentity
    private let session: URLSession

    public init(
        requestSigner: any P256PayloadSigner,
        approvalSigner: any P256PayloadSigner,
        transportIdentity: LibP2PIdentity,
        session: URLSession? = nil
    ) {
        self.requestSigner = requestSigner
        self.approvalSigner = approvalSigner
        self.transportIdentity = transportIdentity
        self.session = session ?? URLSession(
            configuration: .ephemeral,
            delegate: RejectRedirectURLSessionDelegate.shared,
            delegateQueue: nil
        )
    }

    public func pair(
        invitation: PairingInvitation,
        deviceID: String,
        displayName: String,
        confirmSAS: @Sendable (String) async -> Bool
    ) async throws -> PairedLaptop {
        try validate(invitation: invitation, deviceID: deviceID, displayName: displayName)
        guard let relayURL = URL(string: invitation.relayWebSocketUrl) else { throw ExarchError.invalidEncoding }
        let route = RelayRouteConfiguration(
            relayWebSocketURL: relayURL,
            routingID: invitation.routingId,
            accessToken: String(repeating: "pairing-pending-", count: 3),
            expectedHostPeerID: invitation.hostTransportPeerId
        )
        let channel = try await NativeNoiseConnection.connect(
            route: route,
            ticket: invitation.deviceTicket,
            identity: transportIdentity,
            session: session
        )
        defer { Task { await channel.close() } }

        let unsigned = PairingRequestUnsigned(
            version: 1,
            type: "pair.request",
            invitationId: invitation.invitationId,
            deviceId: deviceID,
            displayName: displayName,
            signingPublicKey: requestSigner.encodedPublicKey,
            approvalPublicKey: approvalSigner.encodedPublicKey,
            transportPeerId: transportIdentity.peerID
        )
        let requestPayload = try CanonicalJSON.encode([
            "domain": "exarch/pairing-request/1",
            "invitation": invitationTranscript(invitation),
            "request": try jsonObject(unsigned)
        ])
        let request = PairingRequest(
            unsigned: unsigned,
            signature: try await requestSigner.sign(requestPayload, reason: nil).base64URLEncodedString
        )
        try await send(request, over: channel)
        let challenge: PairingChallenge = try await receive(PairingChallenge.self, over: channel)

        let transcriptPayload = try CanonicalJSON.encode([
            "domain": "exarch/pairing-transcript/1",
            "invitation": invitationTranscript(invitation),
            "request": try jsonObject(unsigned)
        ])
        let transcriptHash = "sha256:\(SHA256.hash(data: transcriptPayload).map { String(format: "%02x", $0) }.joined())"
        let digest = Data(SHA256.hash(data: transcriptPayload))
        let sasNumber = digest.prefix(8).reduce(UInt64(0)) { ($0 << 8) | UInt64($1) }
            % 1_000_000_000_000_000_000
        let sas = String(format: "%018llu", sasNumber)
        guard challenge.version == 1,
              challenge.type == "pair.challenge",
              challenge.transcriptHash == transcriptHash,
              challenge.sas == sas,
              let hostSignature = try? Data(canonicalBase64URL: challenge.hostSignature),
              verifyP256Signature(
                hostSignature,
                payload: try CanonicalJSON.encode([
                    "domain": "exarch/pairing-host-challenge/1",
                    "sas": sas,
                    "transcriptHash": transcriptHash
                ]),
                encodedPublicKey: invitation.hostSigningPublicKey
              )
        else { throw ExarchError.authenticationFailed }

        guard await confirmSAS(sas) else {
            try await send(PairingReject(version: 1, type: "pair.reject", code: "declined"), over: channel)
            throw ExarchError.authenticationFailed
        }
        let confirmationPayload = try CanonicalJSON.encode([
            "domain": "exarch/pairing-device-confirmation/1",
            "transcriptHash": transcriptHash
        ])
        try await send(
            PairingConfirm(
                version: 1,
                type: "pair.confirm",
                transcriptHash: transcriptHash,
                deviceSignature: try await requestSigner.sign(confirmationPayload, reason: nil).base64URLEncodedString
            ),
            over: channel
        )
        let complete: PairingComplete = try await receive(PairingComplete.self, over: channel)
        let completionPayload = try CanonicalJSON.encode([
            "deviceId": deviceID,
            "domain": "exarch/pairing-complete/1",
            "relayAccessToken": complete.relayAccessToken,
            "transcriptHash": transcriptHash
        ])
        guard complete.version == 1,
              complete.type == "pair.complete",
              complete.deviceId == deviceID,
              complete.transcriptHash == transcriptHash,
              complete.relayAccessToken.count >= 32,
              complete.relayAccessToken.count <= 4096,
              let completionSignature = try? Data(canonicalBase64URL: complete.hostSignature),
              verifyP256Signature(
                completionSignature,
                payload: completionPayload,
                encodedPublicKey: invitation.hostSigningPublicKey
              )
        else { throw ExarchError.authenticationFailed }
        let paired = PairedLaptop(
            deviceID: deviceID,
            route: RelayRouteConfiguration(
                relayWebSocketURL: relayURL,
                routingID: invitation.routingId,
                accessToken: complete.relayAccessToken,
                expectedHostPeerID: invitation.hostTransportPeerId
            ),
            transcriptHash: transcriptHash
        )
        await channel.close()
        return paired
    }

    private func send<Value: Encodable>(_ frame: Value, over channel: NativeNoiseConnection) async throws {
        let encoded = try RelayApplicationCodec.encode(frame)
        for start in stride(from: 0, to: encoded.count, by: NativeNoiseConnection.maximumPlaintextFrameBytes) {
            let end = min(start + NativeNoiseConnection.maximumPlaintextFrameBytes, encoded.count)
            try await channel.send(encoded.subdata(in: start..<end))
        }
    }

    private func receive<Value: Decodable>(_ type: Value.Type, over channel: NativeNoiseConnection) async throws -> Value {
        var decoder = RelayApplicationCodec()
        while true {
            for payload in try decoder.append(try await channel.receive()) {
                if let rejection = try? JSONDecoder().decode(PairingReject.self, from: payload),
                   rejection.type == "pair.reject" {
                    throw ExarchError.unavailable("Laptop rejected pairing: \(rejection.code)")
                }
                return try JSONDecoder().decode(type, from: payload)
            }
        }
    }

    private func validate(invitation: PairingInvitation, deviceID: String, displayName: String) throws {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        guard invitation.version == 1,
              invitation.invitationId.count <= 200,
              invitation.routingId.range(of: #"^[A-Za-z0-9_-]{43}$"#, options: .regularExpression) != nil,
              invitation.deviceTicket.count >= 32,
              invitation.deviceTicket.count <= 4096,
              invitation.challenge.count == 43,
              invitation.hostSigningPublicKey.hasPrefix("p256:"),
              !invitation.hostTransportPeerId.isEmpty,
              let expiry = formatter.date(from: invitation.expiresAt),
              expiry > Date(),
              !deviceID.isEmpty, deviceID.count <= 200,
              !displayName.isEmpty, displayName.count <= 200
        else { throw ExarchError.invalidPayload("Pairing invitation is invalid or expired") }
    }

    private func invitationTranscript(_ invitation: PairingInvitation) -> [String: Any] {
        [
            "version": invitation.version,
            "invitationId": invitation.invitationId,
            "relayWebSocketUrl": invitation.relayWebSocketUrl,
            "routingId": invitation.routingId,
            "challenge": invitation.challenge,
            "hostSigningPublicKey": invitation.hostSigningPublicKey,
            "hostTransportPeerId": invitation.hostTransportPeerId,
            "expiresAt": invitation.expiresAt
        ]
    }

    private func jsonObject<Value: Encodable>(_ value: Value) throws -> [String: Any] {
        let data = try JSONEncoder().encode(value)
        guard let object = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw ExarchError.invalidEncoding
        }
        return object
    }
}

private struct PairingRequestUnsigned: Codable {
    let version: Int
    let type: String
    let invitationId: String
    let deviceId: String
    let displayName: String
    let signingPublicKey: String
    let approvalPublicKey: String
    let transportPeerId: String
}

private struct PairingRequest: Codable {
    let version: Int
    let type: String
    let invitationId: String
    let deviceId: String
    let displayName: String
    let signingPublicKey: String
    let approvalPublicKey: String
    let transportPeerId: String
    let signature: String

    init(unsigned: PairingRequestUnsigned, signature: String) {
        version = unsigned.version
        type = unsigned.type
        invitationId = unsigned.invitationId
        deviceId = unsigned.deviceId
        displayName = unsigned.displayName
        signingPublicKey = unsigned.signingPublicKey
        approvalPublicKey = unsigned.approvalPublicKey
        transportPeerId = unsigned.transportPeerId
        self.signature = signature
    }
}

private struct PairingChallenge: Codable {
    let version: Int
    let type: String
    let transcriptHash: String
    let sas: String
    let hostSignature: String
}

private struct PairingConfirm: Codable {
    let version: Int
    let type: String
    let transcriptHash: String
    let deviceSignature: String
}

private struct PairingComplete: Codable {
    let version: Int
    let type: String
    let deviceId: String
    let transcriptHash: String
    let relayAccessToken: String
    let hostSignature: String
}

private struct PairingReject: Codable {
    let version: Int
    let type: String
    let code: String
}
