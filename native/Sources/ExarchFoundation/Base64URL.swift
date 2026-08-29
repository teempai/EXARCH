import Foundation

public extension Data {
    var base64URLEncodedString: String {
        base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }

    init(canonicalBase64URL value: String) throws {
        guard value.range(of: #"^[A-Za-z0-9_-]*$"#, options: .regularExpression) != nil else {
            throw ExarchError.invalidEncoding
        }
        let padding = String(repeating: "=", count: (4 - value.count % 4) % 4)
        let base64 = value
            .replacingOccurrences(of: "-", with: "+")
            .replacingOccurrences(of: "_", with: "/") + padding
        guard let decoded = Data(base64Encoded: base64), decoded.base64URLEncodedString == value else {
            throw ExarchError.invalidEncoding
        }
        self = decoded
    }
}

public enum ExarchError: Error, Equatable, Sendable {
    case invalidEncoding
    case invalidPayload(String)
    case unavailable(String)
    case authenticationFailed
    case responseTooLarge
    case transportClosed
}
