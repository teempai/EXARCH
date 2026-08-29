import Crypto
import Foundation

public struct LibP2PIdentity: Sendable {
    private static let publicKeyPrefix = Data([0x08, 0x01, 0x12, 0x20])
    private static let identityMultihashPrefix = Data([0x00, 0x24])

    let privateKey: Curve25519.Signing.PrivateKey

    public init(rawPrivateKey: Data? = nil) throws {
        if let rawPrivateKey {
            guard rawPrivateKey.count == 32 else { throw ExarchError.invalidEncoding }
            self.privateKey = try Curve25519.Signing.PrivateKey(rawRepresentation: rawPrivateKey)
        } else {
            self.privateKey = Curve25519.Signing.PrivateKey()
        }
    }

    public var rawPrivateKey: Data { privateKey.rawRepresentation }
    public var rawPublicKey: Data { privateKey.publicKey.rawRepresentation }
    public var protobufPublicKey: Data { Self.publicKeyPrefix + rawPublicKey }
    public var peerID: String { Base58BTC.encode(Self.identityMultihashPrefix + protobufPublicKey) }

    public func sign(_ payload: Data) throws -> Data {
        try privateKey.signature(for: payload)
    }

    public static func publicKey(fromPeerID peerID: String) throws -> Data {
        let bytes = try Base58BTC.decode(peerID)
        let expectedPrefix = identityMultihashPrefix + publicKeyPrefix
        guard bytes.count == expectedPrefix.count + 32,
              bytes.prefix(expectedPrefix.count) == expectedPrefix
        else { throw ExarchError.invalidEncoding }
        return bytes.dropFirst(expectedPrefix.count)
    }

    public static func peerID(forRawPublicKey rawPublicKey: Data) throws -> String {
        guard rawPublicKey.count == 32 else { throw ExarchError.invalidEncoding }
        return Base58BTC.encode(identityMultihashPrefix + publicKeyPrefix + rawPublicKey)
    }
}

public actor LibP2PIdentityStore {
    private let store: any SecureValueStore
    private let account: String

    public init(store: any SecureValueStore = KeychainStore(), account: String = "libp2p.ed25519") {
        self.store = store
        self.account = account
    }

    public func identity() throws -> LibP2PIdentity {
        if let raw = try store.read(account: account) {
            return try LibP2PIdentity(rawPrivateKey: raw)
        }
        let identity = try LibP2PIdentity()
        try store.write(identity.rawPrivateKey, account: account)
        return identity
    }
}

enum Base58BTC {
    private static let alphabet = Array("123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz")
    private static let indexes: [UInt8: Int] = Dictionary(
        uniqueKeysWithValues: alphabet.enumerated().map { (Character(String($0.element)).asciiValue!, $0.offset) }
    )

    static func encode(_ data: Data) -> String {
        guard !data.isEmpty else { return "" }
        let bytes = [UInt8](data)
        let zeroes = bytes.prefix { $0 == 0 }.count
        var digits = [Int](repeating: 0, count: max(1, bytes.count * 138 / 100 + 1))
        var length = 0
        for byte in bytes.dropFirst(zeroes) {
            var carry = Int(byte)
            var index = 0
            for position in stride(from: digits.count - 1, through: digits.count - max(length, 1), by: -1) {
                carry += 256 * digits[position]
                digits[position] = carry % 58
                carry /= 58
                index += 1
                if carry == 0 && index >= length { break }
            }
            while carry > 0 {
                let position = digits.count - 1 - index
                digits[position] = carry % 58
                carry /= 58
                index += 1
            }
            length = index
        }
        let start = digits.count - length
        return String(repeating: "1", count: zeroes) + String(digits[start...].map { alphabet[$0] })
    }

    static func decode(_ value: String) throws -> Data {
        guard !value.isEmpty, value.utf8.allSatisfy({ indexes[$0] != nil }) else { throw ExarchError.invalidEncoding }
        let encoded = Array(value.utf8)
        let zeroes = encoded.prefix { $0 == Character("1").asciiValue! }.count
        var bytes = [Int](repeating: 0, count: max(1, encoded.count * 733 / 1000 + 1))
        var length = 0
        for character in encoded.dropFirst(zeroes) {
            guard var carry = indexes[character] else { throw ExarchError.invalidEncoding }
            var index = 0
            for position in stride(from: bytes.count - 1, through: bytes.count - max(length, 1), by: -1) {
                carry += 58 * bytes[position]
                bytes[position] = carry & 0xff
                carry >>= 8
                index += 1
                if carry == 0 && index >= length { break }
            }
            while carry > 0 {
                let position = bytes.count - 1 - index
                bytes[position] = carry & 0xff
                carry >>= 8
                index += 1
            }
            length = index
        }
        let start = bytes.count - length
        return Data(repeating: 0, count: zeroes) + Data(bytes[start...].map(UInt8.init))
    }
}

private extension Character {
    var asciiValue: UInt8? { String(self).utf8.first }
}
