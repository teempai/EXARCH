import CryptoKit
import Foundation

public struct MobileCacheIndex: Codable, Equatable, Sendable {
    public static let currentVersion = 1

    public var version: Int
    public var pairedDeviceID: String
    public var projects: [Project]
    public var conversations: [Conversation]
    public var providerSnapshots: [ProviderSnapshot]
    public var conversationCursor: String?
    public var threadPageCursor: String?
    public var hasMoreThreads: Bool?
    public var messageWatermarks: [String: Int]?
    public var pinnedConversationIDs: [String]
    public var canonicalPins: Bool?
    public var activeConversationID: String?
    public var savedAt: String

    public init(
        pairedDeviceID: String,
        projects: [Project] = [],
        conversations: [Conversation] = [],
        providerSnapshots: [ProviderSnapshot] = [],
        conversationCursor: String? = nil,
        threadPageCursor: String? = nil,
        hasMoreThreads: Bool? = nil,
        messageWatermarks: [String: Int]? = nil,
        pinnedConversationIDs: [String] = [],
        canonicalPins: Bool = true,
        activeConversationID: String? = nil,
        savedAt: String = ISO8601DateFormatter().string(from: Date())
    ) {
        self.version = Self.currentVersion
        self.pairedDeviceID = pairedDeviceID
        self.projects = projects
        self.conversations = conversations
        self.providerSnapshots = providerSnapshots
        self.conversationCursor = conversationCursor
        self.threadPageCursor = threadPageCursor
        self.hasMoreThreads = hasMoreThreads
        self.messageWatermarks = messageWatermarks
        self.pinnedConversationIDs = pinnedConversationIDs
        self.canonicalPins = canonicalPins
        self.activeConversationID = activeConversationID
        self.savedAt = savedAt
    }
}

public struct MobileCacheStore: Sendable {
    private static let maximumIndexBytes = 32 * 1024 * 1024
    private static let maximumEventsBytes = 256 * 1024 * 1024
    private static let encryptionOverheadBytes = 128
    private static let envelopePrefix = Data([0x45, 0x58, 0x41, 0x52, 0x43, 0x48, 0x43, 0x01])
    private static let keyLock = NSLock()
    private let rootDirectory: URL
    private let secureStore: any SecureValueStore
    private let keyAccount: String

    public init(
        rootDirectory: URL? = nil,
        secureStore: any SecureValueStore = KeychainStore(),
        keyAccount: String = "cache.encryption.v1"
    ) {
        self.secureStore = secureStore
        self.keyAccount = keyAccount
        if let rootDirectory {
            self.rootDirectory = rootDirectory
        } else {
            let applicationSupport = FileManager.default.urls(
                for: .applicationSupportDirectory,
                in: .userDomainMask
            ).first ?? FileManager.default.temporaryDirectory
            let current = applicationSupport
                .appendingPathComponent("EXARCH", isDirectory: true)
                .appendingPathComponent("MobileCache", isDirectory: true)
            let legacy = applicationSupport
                .appendingPathComponent("MobileRemoteAgent", isDirectory: true)
                .appendingPathComponent("MobileCache", isDirectory: true)
            if !FileManager.default.fileExists(atPath: current.path),
               FileManager.default.fileExists(atPath: legacy.path) {
                try? FileManager.default.createDirectory(
                    at: current.deletingLastPathComponent(),
                    withIntermediateDirectories: true
                )
                try? FileManager.default.moveItem(at: legacy, to: current)
            }
            self.rootDirectory = current
        }
        // Old releases stored canonical titles and events as plaintext JSON.
        // The cache is disposable and rebuilt from the daemon, so remove only
        // those exact legacy filenames instead of attempting an in-place read.
        try? purgeLegacyPlaintextFiles()
    }

    public func loadIndex(deviceID: String) throws -> MobileCacheIndex? {
        try purgeLegacyPlaintextFiles()
        let url = indexURL(deviceID: deviceID)
        guard FileManager.default.fileExists(atPath: url.path) else { return nil }
        let value = try read(MobileCacheIndex.self, from: url, maximumBytes: Self.maximumIndexBytes)
        guard value.version == MobileCacheIndex.currentVersion,
              value.pairedDeviceID == deviceID else {
            throw ExarchError.invalidPayload("The local mobile cache belongs to another device or schema")
        }
        return value
    }

    public func saveIndex(_ index: MobileCacheIndex) throws {
        try purgeLegacyPlaintextFiles()
        guard index.version == MobileCacheIndex.currentVersion else {
            throw ExarchError.invalidPayload("Unsupported mobile cache schema")
        }
        try write(index, to: indexURL(deviceID: index.pairedDeviceID), maximumBytes: Self.maximumIndexBytes)
    }

    public func loadEvents(deviceID: String, conversationID: String) throws -> [CanonicalEvent] {
        try purgeLegacyPlaintextFiles()
        let url = eventsURL(deviceID: deviceID, conversationID: conversationID)
        guard FileManager.default.fileExists(atPath: url.path) else { return [] }
        let events = try read([CanonicalEvent].self, from: url, maximumBytes: Self.maximumEventsBytes)
        guard events.allSatisfy({ $0.conversationId == conversationID }) else {
            throw ExarchError.invalidPayload("Cached events crossed a conversation boundary")
        }
        guard Set(events.map(\.id)).count == events.count,
              Set(events.map(\.sequence)).count == events.count,
              events.allSatisfy({ $0.sequence > 0 }) else {
            throw ExarchError.invalidPayload("Cached events contain duplicate or invalid identities")
        }
        return events
    }

    public func saveEvents(
        _ events: [CanonicalEvent],
        deviceID: String,
        conversationID: String
    ) throws {
        try purgeLegacyPlaintextFiles()
        guard events.allSatisfy({ $0.conversationId == conversationID }) else {
            throw ExarchError.invalidPayload("Events cannot be cached under another conversation")
        }
        guard Set(events.map(\.id)).count == events.count,
              Set(events.map(\.sequence)).count == events.count,
              events.allSatisfy({ $0.sequence > 0 }) else {
            throw ExarchError.invalidPayload("Events cannot be cached with duplicate or invalid identities")
        }
        try write(
            events,
            to: eventsURL(deviceID: deviceID, conversationID: conversationID),
            maximumBytes: Self.maximumEventsBytes
        )
    }

    public func delete(deviceID: String) throws {
        let directory = deviceDirectory(deviceID: deviceID)
        if FileManager.default.fileExists(atPath: directory.path) {
            try FileManager.default.removeItem(at: directory)
        }
    }

    private func read<Value: Decodable>(
        _ type: Value.Type,
        from url: URL,
        maximumBytes: Int
    ) throws -> Value {
        let attributes = try FileManager.default.attributesOfItem(atPath: url.path)
        let size = (attributes[.size] as? NSNumber)?.intValue ?? maximumBytes + 1
        guard size <= maximumBytes + Self.encryptionOverheadBytes else {
            throw ExarchError.invalidPayload("Local cache file exceeds its safe limit")
        }
        let envelope = try Data(contentsOf: url, options: .mappedIfSafe)
        guard envelope.starts(with: Self.envelopePrefix) else {
            throw ExarchError.invalidPayload("Local cache file is not encrypted")
        }
        let sealedData = Data(envelope.dropFirst(Self.envelopePrefix.count))
        let sealedBox: AES.GCM.SealedBox
        do {
            sealedBox = try AES.GCM.SealedBox(combined: sealedData)
        } catch {
            throw ExarchError.invalidPayload("Local cache encryption envelope is invalid")
        }
        let plaintext: Data
        do {
            plaintext = try AES.GCM.open(
                sealedBox,
                using: cacheKey(),
                authenticating: try authenticatedData(for: url)
            )
        } catch let error as ExarchError {
            throw error
        } catch {
            throw ExarchError.invalidPayload("Local cache authentication failed")
        }
        guard plaintext.count <= maximumBytes else {
            throw ExarchError.invalidPayload("Local cache file exceeds its safe limit")
        }
        return try JSONDecoder().decode(type, from: plaintext)
    }

    private func write<Value: Encodable>(_ value: Value, to url: URL, maximumBytes: Int) throws {
        let data = try JSONEncoder().encode(value)
        guard data.count <= maximumBytes else { throw ExarchError.invalidPayload("Local cache file exceeds its safe limit") }
        let sealed = try AES.GCM.seal(
            data,
            using: cacheKey(),
            authenticating: try authenticatedData(for: url)
        )
        guard let combined = sealed.combined else {
            throw ExarchError.unavailable("Local cache encryption did not produce a portable envelope")
        }
        var envelope = Self.envelopePrefix
        envelope.append(combined)
        try prepareDirectory(url.deletingLastPathComponent())
        var options: Data.WritingOptions = [.atomic]
        #if os(iOS)
        options.insert(.completeFileProtection)
        #endif
        try envelope.write(to: url, options: options)
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
        try excludeFromBackup(url)
    }

    private func prepareDirectory(_ url: URL) throws {
        try FileManager.default.createDirectory(
            at: url,
            withIntermediateDirectories: true,
            attributes: [.posixPermissions: 0o700]
        )
        try excludeFromBackup(url)
    }

    private func indexURL(deviceID: String) -> URL {
        deviceDirectory(deviceID: deviceID).appendingPathComponent("index.cache", isDirectory: false)
    }

    private func eventsURL(deviceID: String, conversationID: String) -> URL {
        deviceDirectory(deviceID: deviceID)
            .appendingPathComponent("events", isDirectory: true)
            .appendingPathComponent("\(digest(conversationID)).cache", isDirectory: false)
    }

    private func deviceDirectory(deviceID: String) -> URL {
        rootDirectory.appendingPathComponent(digest(deviceID), isDirectory: true)
    }

    private func digest(_ value: String) -> String {
        SHA256.hash(data: Data(value.utf8)).map { String(format: "%02x", $0) }.joined()
    }

    private func cacheKey() throws -> SymmetricKey {
        Self.keyLock.lock()
        defer { Self.keyLock.unlock() }
        if let existing = try secureStore.read(account: keyAccount) {
            guard existing.count == 32 else {
                throw ExarchError.invalidPayload("Local cache encryption key has an invalid size")
            }
            return SymmetricKey(data: existing)
        }
        let generated = SymmetricKey(size: .bits256)
        let encoded = generated.withUnsafeBytes { Data($0) }
        try secureStore.write(encoded, account: keyAccount)
        guard let persisted = try secureStore.read(account: keyAccount), persisted.count == 32 else {
            throw ExarchError.unavailable("Local cache encryption key could not be persisted")
        }
        return SymmetricKey(data: persisted)
    }

    private func authenticatedData(for url: URL) throws -> Data {
        let root = rootDirectory.standardizedFileURL.path
        let path = url.standardizedFileURL.path
        let prefix = root.hasSuffix("/") ? root : root + "/"
        guard path.hasPrefix(prefix) else {
            throw ExarchError.invalidPayload("Local cache path escaped its root")
        }
        return Data("exarch-cache-v1:\(path.dropFirst(root.count))".utf8)
    }

    private func purgeLegacyPlaintextFiles() throws {
        guard FileManager.default.fileExists(atPath: rootDirectory.path),
              let enumerator = FileManager.default.enumerator(
                at: rootDirectory,
                includingPropertiesForKeys: [.isRegularFileKey],
                options: [.skipsHiddenFiles, .skipsPackageDescendants]
              ) else { return }
        for case let url as URL in enumerator {
            let isLegacyIndex = url.lastPathComponent == "index.json"
            let isLegacyEvents = url.pathExtension == "json"
                && url.deletingLastPathComponent().lastPathComponent == "events"
            if isLegacyIndex || isLegacyEvents {
                try FileManager.default.removeItem(at: url)
            }
        }
    }

    private func excludeFromBackup(_ input: URL) throws {
        var url = input
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        try url.setResourceValues(values)
    }
}
