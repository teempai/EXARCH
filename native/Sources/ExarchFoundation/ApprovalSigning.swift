import CryptoKit
import Foundation

public struct ApprovalDecision: Encodable, Sendable {
    public let choice: String
    public let decidedAt: String
    public let signature: String
}

/// The fields the laptop bound into the approval digest, recovered from the
/// digest payload after it has been checked against the digest itself.
public struct VerifiedApprovalRequest: Equatable, Sendable {
    public let approvalId: String
    public let conversationId: String
    public let turnId: String
    public let provider: String
    public let providerRequestId: String
    /// The directory the provider is running in. Worth showing: it is the blast
    /// radius of whatever is being approved.
    public let workingDirectory: String
    public let choices: [String]
    public let expiresAt: String
    public let request: [String: JSONValue]
}

public struct VerifiedApprovalReview: Equatable, Sendable {
    public let details: String
    public let choices: [String]
}

public struct ApprovalDecisionSigner: Sendable {
    private let deviceID: String
    private let signer: any P256PayloadSigner

    public init(deviceID: String, signer: any P256PayloadSigner) {
        self.deviceID = deviceID
        self.signer = signer
    }

    public func sign(approval: Approval, choice: String, now: Date = Date()) async throws -> ApprovalDecision {
        guard approval.status == "pending", approval.availableChoices.contains(choice) else {
            throw ExarchError.invalidPayload("Approval choice or digest is invalid")
        }
        // Recover the digest from the bytes it was taken over, and confirm those
        // bytes describe the approval this device actually rendered. Without
        // this the signature only attests that the device agreed to whatever
        // digest the laptop named, which is not the property the approval key
        // is supposed to provide (SECURITY.md threat 5.7).
        let verified = try approval.verifiedRequest()
        guard verified.choices.contains(choice) else {
            throw ExarchError.invalidPayload("Approval choice is not one the laptop offered")
        }
        let digest = approval.approvalDigest ?? ""

        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let decidedAt = formatter.string(from: now)
        let payload = try CanonicalJSON.encode([
            "version": 1,
            "approvalId": approval.id,
            "approvalDigest": digest,
            "choice": choice,
            "deviceId": deviceID,
            "decidedAt": decidedAt
        ] as [String: Any])
        let signature = try await signer.sign(payload, reason: "Approve \(choice) for \(approval.provider.displayName)")
        return ApprovalDecision(choice: choice, decidedAt: decidedAt, signature: signature.base64URLEncodedString)
    }
}

public extension Approval {
    var availableChoices: [String] {
        guard case let .array(values)? = request["choices"] else { return [] }
        return values.compactMap { value in
            guard case let .string(choice) = value else { return nil }
            return choice
        }
    }

    var approvalDigest: String? {
        guard case let .string(value)? = request["approvalDigest"] else { return nil }
        return value
    }

    var approvalDigestPayload: String? {
        guard case let .string(value)? = request["approvalDigestPayload"] else { return nil }
        return value
    }

    /// The directory the approved action would run in, once the digest has been
    /// verified. `nil` before verification, so the UI cannot show it as trusted.
    var verifiedWorkingDirectory: String? {
        (try? verifiedRequest())?.workingDirectory
    }

    var summary: String {
        for key in ["command", "description", "reason", "toolName"] {
            if case let .string(value)? = request[key], !value.isEmpty { return value }
        }
        return "Review the exact request from \(provider.displayName)."
    }

    /// A bounded, digest-verified rendering of the complete provider request.
    /// Approval controls are only shown when this projection can be built.
    var verifiedReview: VerifiedApprovalReview? {
        guard let verified = try? verifiedRequest() else { return nil }
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
        guard let requestData = try? encoder.encode(verified.request),
              requestData.count <= 64 * 1024,
              let requestText = String(data: requestData, encoding: .utf8)
        else { return nil }
        return VerifiedApprovalReview(
            details: """
            Working directory: \(verified.workingDirectory)
            Expires: \(verified.expiresAt)

            Provider request:
            \(requestText)
            """,
            choices: verified.choices
        )
    }

    /// Verifies that `approvalDigest` is the SHA-256 of `approvalDigestPayload`,
    /// and that the payload's fields match this record. Hashing the bytes the
    /// laptop sent avoids having to reproduce its canonical JSON encoding here;
    /// only structural comparison of the decoded fields is needed, which does
    /// not depend on key ordering or number formatting agreeing across
    /// TypeScript and Swift.
    func verifiedRequest() throws -> VerifiedApprovalRequest {
        guard let digest = approvalDigest,
              digest.range(of: #"^sha256:[a-f0-9]{64}$"#, options: .regularExpression) != nil,
              let encodedPayload = approvalDigestPayload
        else { throw ExarchError.invalidPayload("Approval is missing a verifiable digest") }

        let payloadBytes = try Data(canonicalBase64URL: encodedPayload)
        let computed = "sha256:" + SHA256.hash(data: payloadBytes).map { String(format: "%02x", $0) }.joined()
        guard computed == digest else {
            throw ExarchError.invalidPayload("Approval digest does not cover the request the laptop sent")
        }

        guard let decoded = try? JSONDecoder().decode([String: JSONValue].self, from: payloadBytes),
              case let .number(version)? = decoded["version"], version == 1,
              case let .string(approvalId)? = decoded["approvalId"],
              case let .string(conversationId)? = decoded["conversationId"],
              case let .string(turnId)? = decoded["turnId"],
              case let .string(providerName)? = decoded["provider"],
              case let .string(providerRequestId)? = decoded["providerRequestId"],
              case let .string(workingDirectory)? = decoded["cwd"],
              case let .string(expiresAt)? = decoded["expiresAt"],
              case let .array(rawChoices)? = decoded["choices"],
              case let .object(payloadRequest)? = decoded["request"]
        else { throw ExarchError.invalidPayload("Approval digest payload is malformed") }

        guard case let .string(actionCommitment)? = payloadRequest["actionCommitment"],
              actionCommitment.range(of: #"^sha256:[a-f0-9]{64}$"#, options: .regularExpression) != nil
        else { throw ExarchError.invalidPayload("Approval is missing its exact-action commitment") }

        let choices = rawChoices.compactMap { value -> String? in
            guard case let .string(choice) = value else { return nil }
            return choice
        }
        guard choices.count == rawChoices.count else {
            throw ExarchError.invalidPayload("Approval digest payload has malformed choices")
        }

        // Everything the device displays has to be inside what it signs.
        guard approvalId == id,
              conversationId == self.conversationId,
              turnId == self.turnId,
              providerName == provider.rawValue,
              expiresAt == self.expiresAt,
              choices == availableChoices
        else { throw ExarchError.invalidPayload("Approval digest payload does not match the approval") }

        // `approvalDigest` and `approvalDigestPayload` are added after the
        // digest is taken, so they are absent from the signed copy by design.
        var rendered = request
        rendered.removeValue(forKey: "approvalDigest")
        rendered.removeValue(forKey: "approvalDigestPayload")
        guard rendered == payloadRequest else {
            throw ExarchError.invalidPayload("Approval digest does not cover the rendered request")
        }

        return VerifiedApprovalRequest(
            approvalId: approvalId,
            conversationId: conversationId,
            turnId: turnId,
            provider: providerName,
            providerRequestId: providerRequestId,
            workingDirectory: workingDirectory,
            choices: choices,
            expiresAt: expiresAt,
            request: payloadRequest
        )
    }
}
