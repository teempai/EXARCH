import CryptoKit
import Foundation

public struct AuthenticationChallenge: Codable, Equatable, Sendable {
    public let nonce: String
    public let expiresAt: String
}

public struct SignedHeaders: Equatable, Sendable {
    public let deviceId: String
    public let nonce: String
    public let counter: UInt64
    public let timestamp: String
    public let signature: String

    public var wireHeaders: [String: String] {
        [
            "x-exarch-device-id": deviceId,
            "x-exarch-nonce": nonce,
            "x-exarch-counter": String(counter),
            "x-exarch-timestamp": timestamp,
            "x-exarch-signature": signature
        ]
    }
}

public struct RequestAuthenticator: Sendable {
    public let deviceId: String
    public let signer: any P256PayloadSigner

    public init(deviceId: String, signer: any P256PayloadSigner) {
        self.deviceId = deviceId
        self.signer = signer
    }

    public func signedHeaders(
        method: String,
        path: String,
        body: Data,
        challenge: AuthenticationChallenge,
        counter: UInt64,
        now: Date = Date()
    ) async throws -> SignedHeaders {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let timestamp = formatter.string(from: now)
        let digest = SHA256.hash(data: body).map { String(format: "%02x", $0) }.joined()
        let payload: [String: Any] = [
            "version": 1,
            "method": method.uppercased(),
            "path": path,
            "bodyHash": "sha256:\(digest)",
            "nonce": challenge.nonce,
            "counter": counter,
            "timestamp": timestamp,
            "challengeExpiresAt": challenge.expiresAt
        ]
        let signature = try await signer.sign(try CanonicalJSON.encode(payload), reason: nil)
        return SignedHeaders(
            deviceId: deviceId,
            nonce: challenge.nonce,
            counter: counter,
            timestamp: timestamp,
            signature: signature.base64URLEncodedString
        )
    }
}
