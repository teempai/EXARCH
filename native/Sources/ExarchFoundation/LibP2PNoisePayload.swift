import Crypto
import Foundation

struct LibP2PNoisePayload: Equatable, Sendable {
    static let signaturePrefix = Data("noise-libp2p-static-key:".utf8)

    let identityPublicKey: Data
    let identitySignature: Data

    static func make(identity: LibP2PIdentity, noiseStaticPublicKey: Data) throws -> Data {
        guard noiseStaticPublicKey.count == 32 else { throw ExarchError.invalidEncoding }
        let signature = try identity.sign(signaturePrefix + noiseStaticPublicKey)
        var output = Data()
        output.appendLengthDelimited(field: 1, value: identity.protobufPublicKey)
        output.appendLengthDelimited(field: 2, value: signature)
        output.append(contentsOf: [0x22, 0x00]) // Empty libp2p Noise extensions.
        return output
    }

    static func decodeAndVerify(
        _ data: Data,
        noiseStaticPublicKey: Data,
        expectedPeerID: String
    ) throws -> LibP2PNoisePayload {
        guard data.count <= 1024, noiseStaticPublicKey.count == 32 else { throw ExarchError.invalidEncoding }
        var reader = ProtobufReader(data)
        var identityKey: Data?
        var signature: Data?
        while !reader.isAtEnd {
            let tag = try reader.varint()
            switch tag {
            case 10:
                guard identityKey == nil else { throw ExarchError.invalidEncoding }
                identityKey = try reader.lengthDelimited(max: 128)
            case 18:
                guard signature == nil else { throw ExarchError.invalidEncoding }
                signature = try reader.lengthDelimited(max: 128)
            case 34:
                _ = try reader.lengthDelimited(max: 512)
            default:
                throw ExarchError.invalidEncoding
            }
        }
        guard let protobuf = identityKey,
              let signature,
              protobuf.count == 36,
              protobuf.prefix(4) == Data([0x08, 0x01, 0x12, 0x20])
        else { throw ExarchError.invalidEncoding }
        let raw = protobuf.dropFirst(4)
        guard try LibP2PIdentity.peerID(forRawPublicKey: raw) == expectedPeerID else {
            throw ExarchError.authenticationFailed
        }
        let publicKey = try Curve25519.Signing.PublicKey(rawRepresentation: raw)
        guard publicKey.isValidSignature(signature, for: signaturePrefix + noiseStaticPublicKey) else {
            throw ExarchError.authenticationFailed
        }
        return LibP2PNoisePayload(identityPublicKey: Data(raw), identitySignature: signature)
    }
}

private struct ProtobufReader {
    private let data: Data
    private var offset = 0

    init(_ data: Data) { self.data = data }
    var isAtEnd: Bool { offset == data.count }

    mutating func varint() throws -> UInt64 {
        var value: UInt64 = 0
        for shift in stride(from: 0, through: 63, by: 7) {
            guard offset < data.count else { throw ExarchError.invalidEncoding }
            let byte = data[offset]
            offset += 1
            if shift == 63 && byte > 1 { throw ExarchError.invalidEncoding }
            value |= UInt64(byte & 0x7f) << UInt64(shift)
            if byte & 0x80 == 0 { return value }
        }
        throw ExarchError.invalidEncoding
    }

    mutating func lengthDelimited(max: Int) throws -> Data {
        let rawLength = try varint()
        guard rawLength <= UInt64(max), rawLength <= UInt64(data.count - offset) else {
            throw ExarchError.invalidEncoding
        }
        let end = offset + Int(rawLength)
        defer { offset = end }
        return data.subdata(in: offset..<end)
    }
}

private extension Data {
    mutating func appendLengthDelimited(field: UInt8, value: Data) {
        append(field << 3 | 2)
        appendVarint(UInt64(value.count))
        append(value)
    }

    mutating func appendVarint(_ value: UInt64) {
        var remaining = value
        while remaining >= 0x80 {
            append(UInt8(remaining & 0x7f) | 0x80)
            remaining >>= 7
        }
        append(UInt8(remaining))
    }
}
