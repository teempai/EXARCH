import Foundation

public struct RelayHTTPRequest: Codable, Equatable, Sendable {
    public let version: Int
    public let type: String
    public let requestId: String
    public let method: String
    public let path: String
    public let headers: [String: String]
    public let body: String

    public init(requestId: String, method: String, path: String, headers: [String: String], body: Data) throws {
        guard requestId.count <= 200,
              ["GET", "POST"].contains(method),
              path.hasPrefix("/api/v1/"),
              !path.contains("#"),
              !path.contains("\\"),
              body.count <= RelayApplicationCodec.maximumBodyBytes
        else { throw ExarchError.invalidPayload("Invalid relay HTTP request") }
        self.version = 1
        self.type = "http.request"
        self.requestId = requestId
        self.method = method
        self.path = path
        self.headers = headers
        self.body = body.base64URLEncodedString
    }
}

public struct RelayHTTPResponse: Codable, Equatable, Sendable {
    public let version: Int
    public let type: String
    public let requestId: String
    public let status: Int
    public let contentType: String
    public let body: String

    public var decodedBody: Data? { try? Data(canonicalBase64URL: body) }
}

public struct RelayApplicationCodec: Sendable {
    public static let maximumBodyBytes = 1_048_576
    public static let maximumEnvelopeBytes = 1_572_864
    private var buffer = Data()

    public init() {}

    public static func encode<T: Encodable>(_ frame: T) throws -> Data {
        let payload = try CanonicalJSON.encode(frame)
        guard payload.count >= 2, payload.count <= maximumEnvelopeBytes else {
            throw ExarchError.responseTooLarge
        }
        var length = UInt32(payload.count).bigEndian
        return withUnsafeBytes(of: &length) { Data($0) } + payload
    }

    public mutating func append(_ data: Data) throws -> [Data] {
        buffer.append(data)
        var payloads: [Data] = []
        while buffer.count >= 4 {
            let length = buffer.prefix(4).reduce(UInt32(0)) { ($0 << 8) | UInt32($1) }
            guard length >= 2, length <= Self.maximumEnvelopeBytes else {
                throw ExarchError.invalidPayload("Invalid relay envelope length")
            }
            guard buffer.count >= Int(length) + 4 else { break }
            payloads.append(buffer.subdata(in: 4..<(Int(length) + 4)))
            buffer.removeSubrange(0..<(Int(length) + 4))
        }
        guard buffer.count <= Self.maximumEnvelopeBytes + 4 else { throw ExarchError.responseTooLarge }
        return payloads
    }

    public func finish() throws {
        guard buffer.isEmpty else { throw ExarchError.transportClosed }
    }
}
