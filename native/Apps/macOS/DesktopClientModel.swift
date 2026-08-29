import ExarchFoundation
import ExarchUI
import SwiftUI

#if os(macOS)
import AppKit
import LocalAuthentication

struct DesktopCapacityFailure: Identifiable {
    let id = UUID()
    let provider: Provider
    let capacity: ProviderCapacity
    let retrySafe: Bool
    let text: String
}

struct DesktopHistoryProviderStatus: Decodable, Equatable, Identifiable {
    var id: Provider { provider }
    let provider: Provider
    let state: String
    let discovered: Int
    let imported: Int
    let error: String?
}

struct DesktopHistoryImportStatus: Decodable, Equatable {
    let state: String
    let startedAt: String?
    let completedAt: String?
    let providers: [DesktopHistoryProviderStatus]
}

/// The native Mac client talks to the signed loopback API exposed by the local
/// daemon. Canonical context remains in the encrypted laptop store; this model
/// keeps only the visible page needed by the current window.
@MainActor
final class DesktopClientModel: ObservableObject {
    enum Phase: Equatable {
        case starting
        case daemonOffline
        case ready
        case failed(String)
    }

    @Published var phase: Phase = .starting
    @Published var conversations: [Conversation] = []
    @Published var activeConversation: Conversation?
    @Published var messages: [ChatMessage] = []
    @Published private(set) var pendingOutgoingMessage: ChatMessage?
    @Published private(set) var turnStatus: ConversationTurnStatus?
    @Published var events: [CanonicalEvent] = []
    @Published var projects: [Project] = []
    @Published var pendingApproval: Approval?
    @Published var pendingCapacityFailure: DesktopCapacityFailure?
    @Published var knownDevices: [LocalDeviceEnrollment.KnownDevice] = []
    @Published private(set) var historyImportStatus: DesktopHistoryImportStatus?
    @Published private(set) var refreshingHistory = false
    @Published private(set) var awaitingInitialHistoryImport = false
    @Published private(set) var repairingLocalService = false
    @Published private(set) var identityRepairRequired = false

    @Published var provider: Provider = .codex
    @Published var modelName = ""
    @Published var policyLabel = "Checking laptop policy"
    @Published var policyDetails = "The laptop has not reported its policy yet."

    @Published var draft = ""
    @Published var busy = false
    @Published var interrupting = false
    @Published var voiceEnabled = false
    @Published var isLoadingMessages = false
    @Published var isLoadingOlderMessages = false
    @Published var canLoadOlderMessages = false
    @Published private(set) var isLoadingMoreThreads = false
    @Published private(set) var hasMoreThreads = true
    @Published var conversationLoadError: String?
    @Published var lastSyncError: String?
    @Published var errorMessage: String?

    @Published var showNewConversation = false
    @Published var showUnpairConfirmation = false
    @Published var projectPendingEnrollment: Project?
    @Published private(set) var enrollingProjectID: String?
    @Published var newConversationTitle = ""
    @Published var selectedProjectID: String?

    private let enrollment: LocalDeviceEnrollment
    private let dataDirectory: URL
    private let serviceRecovery: LocalServiceRecovery
    private let keyManager: DeviceKeyManager
    private var api: RemoteAPIClient?
    private var snapshots: [ProviderSnapshot] = []
    private let cacheStore: MobileCacheStore
    private var pollTask: Task<Void, Never>?
    private var cacheWriteTask: Task<Void, Never>?
    private var legacyPinnedIDs: Set<String> = []
    private var localDeviceID: String?
    private var threadPageCursor: String?
    private var cachedThreadBacklog: [Conversation] = []
    private var remoteHasMoreThreads = true
    private var messageWatermarks: [String: Int] = [:]
    private var cachedConversationEvents: [CanonicalEvent] = []
    private var activeTurnConversationID: String?
    private var userRequestedInterrupt = false
    private var startupGate = DesktopStartupGate()

    private static let initialMessageCount = 30
    private static let threadPageSize = 30
    private static let pinnedKey = "exarch.mac.pinnedConversations"

    init(enrollment: LocalDeviceEnrollment, dataDirectory: URL) {
        self.enrollment = enrollment
        self.dataDirectory = dataDirectory
        let applicationSupport = dataDirectory.deletingLastPathComponent()
        let desktopSecureStore = KeychainCommandStore(
            executableURL: applicationSupport
                .appendingPathComponent("runtime", isDirectory: true)
                .appendingPathComponent("bin", isDirectory: true)
                .appendingPathComponent("exarch-keychain"),
            accountPrefix: "desktop-v2"
        )
        self.serviceRecovery = LocalServiceRecovery(applicationSupport: applicationSupport)
        self.keyManager = DeviceKeyManager(store: desktopSecureStore)
        self.cacheStore = MobileCacheStore(
            rootDirectory: applicationSupport
                .appendingPathComponent("DesktopCache", isDirectory: true),
            secureStore: desktopSecureStore
        )
        legacyPinnedIDs = Set(UserDefaults.standard.stringArray(forKey: Self.pinnedKey) ?? [])
    }

    // MARK: - Derived

    var availableProviders: Set<Provider> {
        Set(snapshots.filter(\.health.available).map(\.health.provider))
    }

    var providerStatuses: [ProviderHealth] { snapshots.map(\.health) }

    var availableModels: [ProviderModel] {
        snapshots.first(where: { $0.health.provider == provider })?.models ?? []
    }

    var currentCapacity: ProviderCapacity? {
        snapshots.first(where: { $0.health.provider == provider })?.capacity
    }

    var displayedMessages: [ChatMessage] {
        guard let pendingOutgoingMessage else { return messages }
        return messages + [pendingOutgoingMessage]
    }

    var capacityAlternatives: [Provider] {
        Provider.allCases.filter { candidate in
            guard candidate != pendingCapacityFailure?.provider,
                  availableProviders.contains(candidate) else { return false }
            return snapshots.first(where: { $0.health.provider == candidate })?.capacity?.status != "exhausted"
        }
    }

    var pinnedConversations: [Conversation] {
        conversations.filter { $0.pinned || legacyPinnedIDs.contains($0.id) }.sorted(by: recency)
    }

    var unpinnedConversations: [Conversation] {
        conversations.filter { !$0.pinned && !legacyPinnedIDs.contains($0.id) }.sorted(by: recency)
    }

    var pairedPhone: LocalDeviceEnrollment.KnownDevice? {
        knownDevices.first {
            $0.isActive && $0.capabilities.contains("mobile-control")
        }
    }

    var enrolledProjects: [Project] { projects.filter { !$0.allowedPaths.isEmpty } }

    var activeProject: Project? {
        guard let projectID = activeConversation?.projectId else { return nil }
        return projects.first { $0.id == projectID }
    }

    var activeBrowseOnlyProject: Project? {
        guard let project = activeProject, project.allowedPaths.isEmpty else { return nil }
        return project
    }

    var initialHistoryImportRunning: Bool {
        awaitingInitialHistoryImport
    }

    private func recency(_ lhs: Conversation, _ rhs: Conversation) -> Bool {
        if lhs.updatedAt != rhs.updatedAt { return lhs.updatedAt > rhs.updatedAt }
        return lhs.id > rhs.id
    }

    private func cacheThreadOrder(_ lhs: Conversation, _ rhs: Conversation) -> Bool {
        if lhs.pinned != rhs.pinned { return lhs.pinned }
        return recency(lhs, rhs)
    }

    // MARK: - Lifecycle

    func start() async {
        guard phase == .starting else { return }
        do {
            guard let status = try DaemonRuntimeStatus.read(dataDirectory: dataDirectory),
                  status.isOnline else {
                switch startupGate.actionForOfflineService() {
                case .restoreService:
                    repairingLocalService = true
                    defer { repairingLocalService = false }
                    try await serviceRecovery.restore()
                    await start()
                case .showOffline:
                    phase = .daemonOffline
                }
                return
            }
            guard let base = status.apiBaseUrl.flatMap(URL.init(string:)) else {
                throw ExarchError.unavailable("The local service reported an invalid loopback address")
            }

            let signing: any P256PayloadSigner
            do {
                signing = try await keyManager.signer(for: .request)
            } catch {
                throw ExarchError.unavailable(
                    "The Mac client could not create its request identity: \(describe(error))"
                )
            }
            let enrolled: LocalDeviceEnrollment.Enrolled
            if let cached = enrollment.cachedEnrollment(signingPublicKey: signing.encodedPublicKey) {
                enrolled = cached
            } else {
                do {
                    if let existing = try await enrollment.existingDevice(
                        signingPublicKey: signing.encodedPublicKey
                    ) {
                        enrolled = existing
                    } else if try await enrollment.listDevices().contains(where: {
                        $0.isActive && $0.capabilities.contains("mac-client")
                    }) {
                        identityRepairRequired = true
                        throw ExarchError.unavailable(
                            "A previous Mac client identity is still active and needs an explicit repair"
                        )
                    } else {
                        try await authenticateUser(
                            reason: "Allow EXARCH to enroll this Mac client with its local service."
                        )
                        let approval = try await keyManager.signer(for: .approval)
                        enrolled = try await enrollment.enroll(
                            signingPublicKey: signing.encodedPublicKey,
                            approvalPublicKey: approval.encodedPublicKey,
                            displayName: Host.current().localizedName ?? "This Mac"
                        )
                    }
                } catch {
                    let detail = describe(error)
                    if detail.contains("different Mac client identity")
                        || detail.contains("identity was revoked")
                        || detail.contains("approval key does not match") {
                        identityRepairRequired = true
                    }
                    throw ExarchError.unavailable(
                        "The Mac client could not enroll with the local service: \(detail)"
                    )
                }
            }
            try enrollment.remember(enrolled, signingPublicKey: signing.encodedPublicKey)
            localDeviceID = enrolled.deviceId
            await restoreCache(deviceID: enrolled.deviceId)

            let transport = try LoopbackTransport(baseURL: base)
            api = RemoteAPIClient(
                transport: transport,
                authenticator: RequestAuthenticator(deviceId: enrolled.deviceId, signer: signing),
                counterStore: ProtectedFileRequestCounter(
                    url: dataDirectory.appendingPathComponent("request-counters", isDirectory: true)
                        .appendingPathComponent(enrolled.deviceId),
                    minimum: enrolled.lastCounter
                )
            )
            awaitingInitialHistoryImport = conversations.isEmpty
            identityRepairRequired = false
            try await refreshStartupAuthoritatively()
            startupGate.recordAuthoritativeRefresh()
            phase = .ready
            startPolling()
            await prefetchRecentMessages(for: conversations)
        } catch {
            phase = .failed(describe(error))
        }
    }

    /// launchd may report the daemon online a fraction before its signed API
    /// is ready to serve the first complete refresh. Keep the honest
    /// connecting state during that bounded grace period instead of flashing
    /// a Reconnect screen for a connection that is already succeeding.
    private func refreshStartupAuthoritatively() async throws {
        var lastError: Error?
        for attempt in 0..<4 {
            do {
                try await refreshAllAuthoritatively(prefetchMessages: false)
                return
            } catch {
                lastError = error
                guard attempt < 3 else { break }
                try await Task.sleep(for: .milliseconds(400 * (attempt + 1)))
            }
        }
        throw lastError ?? ExarchError.unavailable("The local service did not complete startup")
    }

    func retry() {
        pollTask?.cancel()
        startupGate = DesktopStartupGate()
        phase = .starting
        Task { await start() }
    }

    /// One recovery action for the UI. Never touch daemon credentials when the
    /// native service is already healthy; only ask launchd to restore a service
    /// that is actually offline.
    func reconnect() {
        if identityRepairRequired {
            repairLocalIdentity()
            return
        }
        if let status = try? DaemonRuntimeStatus.read(dataDirectory: dataDirectory),
           status.isOnline {
            retry()
        } else {
            restoreLocalService()
        }
    }

    private func repairLocalIdentity() {
        guard !repairingLocalService else { return }
        repairingLocalService = true
        Task {
            do {
                try await authenticateUser(
                    reason: "Replace the disconnected EXARCH Mac identity. Phone pairing and conversation history will be preserved."
                )
                let signing = try await keyManager.signer(for: .request)
                let approval = try await keyManager.signer(for: .approval)
                let enrolled = try await enrollment.repair(
                    signingPublicKey: signing.encodedPublicKey,
                    approvalPublicKey: approval.encodedPublicKey,
                    displayName: Host.current().localizedName ?? "This Mac"
                )
                try enrollment.remember(enrolled, signingPublicKey: signing.encodedPublicKey)
                identityRepairRequired = false
                phase = .starting
                repairingLocalService = false
                await start()
            } catch {
                repairingLocalService = false
                phase = .failed("EXARCH could not repair its Mac identity. \(describe(error))")
            }
        }
    }

    func restoreLocalService() {
        guard !repairingLocalService else { return }
        repairingLocalService = true
        errorMessage = nil
        Task {
            do {
                try await serviceRecovery.restore()
                startupGate = DesktopStartupGate()
                phase = .starting
                repairingLocalService = false
                await start()
            } catch {
                repairingLocalService = false
                phase = .failed(
                    "EXARCH could not unlock and restart its local service. \(describe(error))"
                )
            }
        }
    }

    private func startPolling() {
        pollTask?.cancel()
        pollTask = Task { [weak self] in
            var count = 0
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(2))
                guard let self else { return }
                do {
                    if let id = self.activeConversation?.id {
                        try await self.refreshNewMessages(id)
                        try await self.refreshApprovals(id)
                    }
                    count += 1
                    if count.isMultiple(of: 5) {
                        try await self.refreshProviderSnapshots()
                        try await self.refreshConversationIndex()
                        self.knownDevices = try await self.enrollment.listDevices()
                    }
                    if self.initialHistoryImportRunning {
                        try await self.refreshHistoryStatus()
                        try await self.refreshConversationIndex()
                        if !Self.importIsRunning(self.historyImportStatus) {
                            self.awaitingInitialHistoryImport = false
                            try await self.refreshProviderSnapshots()
                            if self.activeConversation == nil,
                               let first = (self.pinnedConversations + self.unpinnedConversations).first {
                                await self.select(first)
                            }
                        }
                    }
                    self.lastSyncError = nil
                } catch {
                    self.lastSyncError = self.describe(error)
                }
            }
        }
    }

    // MARK: - Loading

    func refreshAll() async {
        do {
            try await refreshAllAuthoritatively(prefetchMessages: true)
            lastSyncError = nil
        } catch {
            lastSyncError = describe(error)
        }
    }

    private func refreshAllAuthoritatively(prefetchMessages: Bool) async throws {
        guard let api else { throw ExarchError.unavailable("Local service is unavailable") }
        projects = try await api.get("/api/v1/projects", as: [Project].self)
            .sorted { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }
        snapshots = try await api.get("/api/v1/providers", as: [ProviderSnapshot].self)
        try await refreshHistoryStatus()
        try await refreshLoadedThreadWindow(prefetchMessages: prefetchMessages)
        try await migrateLegacyPins(using: api)
        awaitingInitialHistoryImport = conversations.isEmpty && Self.importIsRunning(historyImportStatus)
        knownDevices = try await enrollment.listDevices()
        if !enrolledProjects.contains(where: { $0.id == selectedProjectID }) {
            selectedProjectID = enrolledProjects.first?.id
        }
        if !awaitingInitialHistoryImport,
           activeConversation == nil,
           let first = (pinnedConversations + unpinnedConversations).first {
            await select(first)
        } else {
            updatePolicyLabel()
        }
        lastSyncError = nil
    }

    func select(_ conversation: Conversation) async {
        guard conversation.id != activeConversation?.id, !busy else { return }
        activeConversation = conversation
        provider = conversation.activeProvider ?? .codex
        modelName = ""
        messages = []
        pendingOutgoingMessage = nil
        turnStatus = nil
        events = []
        cachedConversationEvents = []
        pendingApproval = nil
        conversationLoadError = nil
        isLoadingMessages = true
        isLoadingOlderMessages = false
        canLoadOlderMessages = false
        updatePolicyLabel()
        await hydrateEventsFromCache(conversation.id)
        do {
            try await refreshPolicy(provider, conversationID: conversation.id)
            try await refreshRecentMessages(conversation.id)
            try await refreshApprovals(conversation.id)
        } catch {
            guard activeConversation?.id == conversation.id else { return }
            conversationLoadError = "Messages couldn’t load. Check the local service and try again."
            lastSyncError = describe(error)
        }
        if activeConversation?.id == conversation.id { isLoadingMessages = false }
    }

    func loadOlderMessages() {
        guard let conversation = activeConversation,
              canLoadOlderMessages,
              !isLoadingOlderMessages else { return }
        isLoadingOlderMessages = true
        conversationLoadError = nil
        let conversationID = conversation.id
        Task {
            defer { isLoadingOlderMessages = false }
            let before = messages.first?.sequence ?? conversation.nextSequence
            let cachedOlder = cachedConversationEvents.filter {
                Self.isDisplayEvent($0) && $0.sequence < before
            }
            let localPage = Array(cachedOlder.suffix(Self.initialMessageCount))
            guard activeConversation?.id == conversationID else { return }
            merge(localPage)
            let remaining = Self.initialMessageCount - localPage.count
            guard remaining > 0 else {
                canLoadOlderMessages = true
                return
            }
            do {
                let serverBefore = localPage.first?.sequence ?? before
                let page = try await fetchMessagePage(
                    conversationID,
                    before: serverBefore,
                    limit: remaining
                )
                guard activeConversation?.id == conversationID else { return }
                merge(page)
                canLoadOlderMessages = page.count == remaining
                persistCurrentEvents()
            } catch {
                guard activeConversation?.id == conversationID else { return }
                conversationLoadError = "Earlier messages couldn’t load. Try again."
                lastSyncError = describe(error)
            }
        }
    }

    func retryConversationMessages() {
        guard let conversation = activeConversation, !isLoadingMessages else { return }
        isLoadingMessages = true
        conversationLoadError = nil
        let id = conversation.id
        Task {
            do { try await refreshRecentMessages(id) }
            catch {
                if activeConversation?.id == id {
                    conversationLoadError = "Messages couldn’t load. Check the local service and try again."
                    lastSyncError = describe(error)
                }
            }
            if activeConversation?.id == id { isLoadingMessages = false }
        }
    }

    func loadMoreThreads() {
        guard hasMoreThreads, !isLoadingMoreThreads, api != nil else { return }
        isLoadingMoreThreads = true
        Task {
            defer { isLoadingMoreThreads = false }
            if !cachedThreadBacklog.isEmpty {
                let local = Array(cachedThreadBacklog.prefix(Self.threadPageSize))
                cachedThreadBacklog.removeFirst(min(Self.threadPageSize, cachedThreadBacklog.count))
                mergeConversations(local)
                hasMoreThreads = !cachedThreadBacklog.isEmpty || remoteHasMoreThreads
                persistIndex()
                return
            }
            do {
                let page = try await fetchThreadPage(after: threadPageCursor)
                mergeConversations(page.conversations)
                threadPageCursor = page.nextCursor
                remoteHasMoreThreads = page.hasMore
                hasMoreThreads = remoteHasMoreThreads
                persistIndex()
                await prefetchRecentMessages(for: page.conversations)
                lastSyncError = nil
            } catch {
                lastSyncError = describe(error)
            }
        }
    }

    private func refreshRecentMessages(_ conversationID: String) async throws {
        guard let conversation = activeConversation, conversation.id == conversationID else { return }
        let page = try await fetchMessagePage(
            conversationID,
            before: conversation.nextSequence,
            limit: Self.initialMessageCount
        )
        guard activeConversation?.id == conversationID else { return }
        mergeIntoCache(page)
        let displayEvents = cachedConversationEvents.filter(Self.isDisplayEvent)
        events = Array(displayEvents.suffix(Self.initialMessageCount))
        messages = ConversationProjection.messages(from: events).sorted { $0.sequence < $1.sequence }
        canLoadOlderMessages = displayEvents.count > events.count || page.count == Self.initialMessageCount
        messageWatermarks[conversationID] = conversation.nextSequence
        persistCurrentEvents()
        persistIndex()
        try await refreshNewMessages(conversationID)
    }

    private func refreshNewMessages(_ conversationID: String) async throws {
        guard activeConversation?.id == conversationID else { return }
        var after = events.map(\.sequence).max() ?? 0
        let pageSize = 50
        while true {
            let page = try await fetchMessagePage(conversationID, after: after, limit: pageSize)
            guard activeConversation?.id == conversationID else { return }
            merge(page)
            if page.count < pageSize { break }
            guard let next = page.map(\.sequence).max(), next > after else {
                throw ExarchError.invalidPayload("Laptop event pagination did not advance")
            }
            after = next
        }
        persistCurrentEvents()
    }

    private func fetchMessagePage(
        _ conversationID: String,
        after: Int? = nil,
        before: Int? = nil,
        limit: Int
    ) async throws -> [CanonicalEvent] {
        guard let api else { throw ExarchError.unavailable("Local service is unavailable") }
        var components = URLComponents()
        components.path = "/api/v1/conversations/\(conversationID)/events"
        components.queryItems = [
            URLQueryItem(name: "limit", value: String(limit)),
            URLQueryItem(name: "view", value: "messages")
        ]
        if let after { components.queryItems?.append(URLQueryItem(name: "after", value: String(after))) }
        if let before { components.queryItems?.append(URLQueryItem(name: "before", value: String(before))) }
        guard let path = components.string else {
            throw ExarchError.invalidPayload("Message pagination URL could not be created")
        }
        return try await api.get(path, as: [CanonicalEvent].self)
    }

    private func merge(_ incoming: [CanonicalEvent]) {
        mergeIntoCache(incoming)
        let knownEvents = Set(events.map(\.id))
        events += incoming.filter { !knownEvents.contains($0.id) }
        events.sort { $0.sequence < $1.sequence }
        messages = ConversationProjection.messages(from: events)
            .sorted { $0.sequence < $1.sequence }
    }

    private func mergeIntoCache(_ incoming: [CanonicalEvent]) {
        let known = Set(cachedConversationEvents.map(\.id))
        cachedConversationEvents += incoming.filter { !known.contains($0.id) }
        cachedConversationEvents.sort { $0.sequence < $1.sequence }
    }

    private static func isDisplayEvent(_ event: CanonicalEvent) -> Bool {
        ["user.message", "assistant.message.completed", "provider.handoff.completed"].contains(event.type)
    }

    private func refreshApprovals(_ conversationID: String) async throws {
        guard let api, activeConversation?.id == conversationID else { return }
        let approvals: [Approval] = try await api.get(
            "/api/v1/approvals?conversationId=\(conversationID)&status=pending",
            as: [Approval].self
        )
        if pendingApproval?.id != approvals.first?.id { pendingApproval = approvals.first }
    }

    private func refreshProviderSnapshots() async throws {
        guard let api else { throw ExarchError.unavailable("Local service is unavailable") }
        var refreshed = try await api.get("/api/v1/providers", as: [ProviderSnapshot].self)
        if let conversation = activeConversation,
           let prior = snapshots.first(where: { $0.health.provider == provider })?.policy,
           let index = refreshed.firstIndex(where: { $0.health.provider == provider }) {
            refreshed[index] = ProviderSnapshot(
                health: refreshed[index].health,
                policy: prior,
                models: refreshed[index].models,
                capacity: refreshed[index].capacity
            )
            snapshots = refreshed
            try await refreshPolicy(provider, conversationID: conversation.id)
        } else {
            snapshots = refreshed
            updatePolicyLabel()
        }
    }

    private func refreshHistoryStatus() async throws {
        guard let api else { throw ExarchError.unavailable("Local service is unavailable") }
        historyImportStatus = try await api.get(
            "/api/v1/history-import/status",
            as: DesktopHistoryImportStatus.self
        )
    }

    private static func importIsRunning(_ status: DesktopHistoryImportStatus?) -> Bool {
        guard let status else { return true }
        return status.state == "idle" || status.state == "running"
    }

    func refreshNativeHistory() async {
        guard let api, !refreshingHistory else { return }
        refreshingHistory = true
        defer { refreshingHistory = false }
        do {
            historyImportStatus = try await api.post(
                "/api/v1/history-import/refresh",
                input: EmptyRequest(),
                as: DesktopHistoryImportStatus.self
            )
            // The daemon accepted the scan. Poll its status while the native
            // histories are imported instead of holding this request open.
            awaitingInitialHistoryImport = true
            lastSyncError = nil
        } catch {
            errorMessage = "Harness scan did not complete. \(describe(error))"
        }
    }

    private func refreshConversationIndex() async throws {
        try await refreshLoadedThreadWindow()
    }

    private func refreshLoadedThreadWindow(prefetchMessages: Bool = true) async throws {
        guard api != nil else { throw ExarchError.unavailable("Local service is unavailable") }
        let targetCount = max(Self.threadPageSize, conversations.count)
        let previousVisible = conversations
        let savedCursor = threadPageCursor
        let savedRemoteHasMore = remoteHasMoreThreads
        var refreshed: [Conversation] = []
        var cursor: String?
        var lastPage: ConversationListPage?
        repeat {
            let page = try await fetchThreadPage(after: cursor)
            refreshed += page.conversations
            lastPage = page
            guard page.hasMore, refreshed.count < targetCount else { break }
            guard let next = page.nextCursor, next != cursor else {
                throw ExarchError.invalidPayload("Local thread pagination did not advance")
            }
            cursor = next
        } while true
        conversations = Array(refreshed.prefix(targetCount)).sorted(by: recency)
        let visibleIDs = Set(conversations.map(\.id))
        var backlogByID = Dictionary(uniqueKeysWithValues: cachedThreadBacklog.map { ($0.id, $0) })
        for displaced in previousVisible where !visibleIDs.contains(displaced.id) {
            backlogByID[displaced.id] = displaced
        }
        cachedThreadBacklog = backlogByID.values
            .filter { !visibleIDs.contains($0.id) }
            .sorted(by: cacheThreadOrder)
        if cachedThreadBacklog.isEmpty {
            threadPageCursor = lastPage?.nextCursor
            remoteHasMoreThreads = lastPage?.hasMore ?? false
        } else {
            threadPageCursor = savedCursor
            remoteHasMoreThreads = savedRemoteHasMore
        }
        hasMoreThreads = !cachedThreadBacklog.isEmpty || remoteHasMoreThreads
        let validIDs = Set(conversations.map(\.id)).union(cachedThreadBacklog.map(\.id))
        messageWatermarks = messageWatermarks.filter { validIDs.contains($0.key) }
        if let id = activeConversation?.id,
           let refreshedActive = conversations.first(where: { $0.id == id }) {
            activeConversation = refreshedActive
        }
        persistIndex()
        if prefetchMessages { await prefetchRecentMessages(for: conversations) }
    }

    private func fetchThreadPage(after cursor: String?) async throws -> ConversationListPage {
        guard let api else { throw ExarchError.unavailable("Local service is unavailable") }
        var components = URLComponents()
        components.path = "/api/v1/conversations/page"
        components.queryItems = [URLQueryItem(name: "limit", value: String(Self.threadPageSize))]
        if let cursor { components.queryItems?.append(URLQueryItem(name: "cursor", value: cursor)) }
        guard let path = components.string else {
            throw ExarchError.invalidPayload("Thread pagination URL could not be created")
        }
        return try await api.get(path, as: ConversationListPage.self)
    }

    private func mergeConversations(_ updates: [Conversation]) {
        var byID = Dictionary(uniqueKeysWithValues: conversations.map { ($0.id, $0) })
        for conversation in updates { byID[conversation.id] = conversation }
        conversations = byID.values.sorted(by: recency)
        if let id = activeConversation?.id, let refreshed = byID[id] {
            activeConversation = refreshed
        }
    }

    private func prefetchRecentMessages(for page: [Conversation]) async {
        guard let deviceID = localDeviceID else { return }
        for conversation in page where messageWatermarks[conversation.id] != conversation.nextSequence {
            do {
                let recent = try await fetchMessagePage(
                    conversation.id,
                    before: conversation.nextSequence,
                    limit: Self.initialMessageCount
                )
                let cacheStore = cacheStore
                try await Task.detached {
                    let cached = (try? cacheStore.loadEvents(
                        deviceID: deviceID,
                        conversationID: conversation.id
                    )) ?? []
                    var byID = Dictionary(uniqueKeysWithValues: cached.map { ($0.id, $0) })
                    for event in recent { byID[event.id] = event }
                    try cacheStore.saveEvents(
                        byID.values.sorted { $0.sequence < $1.sequence },
                        deviceID: deviceID,
                        conversationID: conversation.id
                    )
                }.value
                messageWatermarks[conversation.id] = conversation.nextSequence
                persistIndex()
                if activeConversation?.id == conversation.id {
                    await hydrateEventsFromCache(conversation.id)
                }
            } catch {
                lastSyncError = describe(error)
            }
        }
    }

    private func restoreCache(deviceID: String) async {
        do {
            let cacheStore = cacheStore
            guard let index = try await Task.detached(operation: {
                try cacheStore.loadIndex(deviceID: deviceID)
            }).value else { return }
            projects = index.projects
            let cached = index.conversations.sorted(by: cacheThreadOrder)
            conversations = Array(cached.prefix(Self.threadPageSize))
            cachedThreadBacklog = Array(cached.dropFirst(Self.threadPageSize))
            snapshots = index.providerSnapshots
            threadPageCursor = index.threadPageCursor
            remoteHasMoreThreads = index.hasMoreThreads ?? true
            hasMoreThreads = !cachedThreadBacklog.isEmpty || remoteHasMoreThreads
            messageWatermarks = index.messageWatermarks ?? [:]
            activeConversation = index.activeConversationID
                .flatMap { id in conversations.first(where: { $0.id == id }) }
                ?? conversations.first
            if let conversation = activeConversation {
                provider = conversation.activeProvider ?? .codex
                await hydrateEventsFromCache(conversation.id)
            }
            updatePolicyLabel()
        } catch {
            lastSyncError = "Saved threads could not be opened. EXARCH will rebuild its cache."
        }
    }

    private func hydrateEventsFromCache(_ conversationID: String) async {
        guard let deviceID = localDeviceID else { return }
        do {
            let cacheStore = cacheStore
            let cached = try await Task.detached(operation: {
                try cacheStore.loadEvents(deviceID: deviceID, conversationID: conversationID)
            }).value
            guard activeConversation?.id == conversationID else { return }
            cachedConversationEvents = cached.sorted { $0.sequence < $1.sequence }
            let displayEvents = cachedConversationEvents.filter(Self.isDisplayEvent)
            events = Array(displayEvents.suffix(Self.initialMessageCount))
            messages = ConversationProjection.messages(from: events).sorted { $0.sequence < $1.sequence }
            canLoadOlderMessages = displayEvents.count > events.count || events.count == Self.initialMessageCount
        } catch {
            guard activeConversation?.id == conversationID else { return }
            cachedConversationEvents = []
            events = []
            messages = []
            canLoadOlderMessages = false
        }
    }

    private func persistIndex() {
        guard let deviceID = localDeviceID else { return }
        var cachedByID = Dictionary(uniqueKeysWithValues: cachedThreadBacklog.map { ($0.id, $0) })
        for conversation in conversations { cachedByID[conversation.id] = conversation }
        let index = MobileCacheIndex(
            pairedDeviceID: deviceID,
            projects: projects,
            conversations: cachedByID.values.sorted(by: cacheThreadOrder),
            providerSnapshots: snapshots,
            threadPageCursor: threadPageCursor,
            hasMoreThreads: remoteHasMoreThreads,
            messageWatermarks: messageWatermarks,
            pinnedConversationIDs: conversations.filter(\.pinned).map(\.id),
            activeConversationID: activeConversation?.id
        )
        let cacheStore = cacheStore
        enqueueCacheWrite { try? cacheStore.saveIndex(index) }
    }

    private func persistCurrentEvents() {
        guard let deviceID = localDeviceID, let conversationID = activeConversation?.id else { return }
        let current = cachedConversationEvents
        let cacheStore = cacheStore
        enqueueCacheWrite {
            try? cacheStore.saveEvents(current, deviceID: deviceID, conversationID: conversationID)
        }
    }

    private func enqueueCacheWrite(_ operation: @escaping @Sendable () -> Void) {
        let previous = cacheWriteTask
        cacheWriteTask = Task.detached {
            if let previous { await previous.value }
            operation()
        }
    }

    @discardableResult
    private func refreshPolicy(_ selected: Provider, conversationID: String) async throws -> EffectivePolicy {
        guard let api else { throw ExarchError.unavailable("Local service is unavailable") }
        let policy: EffectivePolicy = try await api.get(
            "/api/v1/providers/\(selected.rawValue)/effective-policy?conversationId=\(conversationID)",
            as: EffectivePolicy.self
        )
        cachePolicy(policy, for: selected)
        return policy
    }

    private func cachePolicy(_ policy: EffectivePolicy, for selected: Provider) {
        if let index = snapshots.firstIndex(where: { $0.health.provider == selected }) {
            snapshots[index] = ProviderSnapshot(
                health: snapshots[index].health,
                policy: policy,
                models: snapshots[index].models,
                capacity: snapshots[index].capacity
            )
        }
        updatePolicyLabel()
    }

    private func updatePolicyLabel() {
        guard let snapshot = snapshots.first(where: { $0.health.provider == provider }) else {
            policyLabel = "Policy unavailable"
            policyDetails = "No policy observation is available for this harness."
            return
        }
        apply(snapshot.policy)
    }

    private func updateCapacity(_ capacity: ProviderCapacity) {
        guard let index = snapshots.firstIndex(where: { $0.health.provider == capacity.provider }) else { return }
        snapshots[index] = ProviderSnapshot(
            health: snapshots[index].health,
            policy: snapshots[index].policy,
            models: snapshots[index].models,
            capacity: capacity
        )
    }

    private func apply(_ policy: EffectivePolicy) {
        policyLabel = "Laptop policy · \(policy.status)"
        let automatic = policy.normalized.mayExecuteWithoutPrompt.map(String.init) ?? "provider-defined"
        policyDetails = [
            "Harness: \(policy.provider.displayName)",
            "Status: \(policy.status)",
            "Source: \(policy.source)",
            "Reviewer/mode: \(policy.normalized.reviewer ?? "provider-defined")",
            "Sandbox: \(policy.normalized.sandbox ?? "provider-defined")",
            "May execute without prompt: \(automatic)",
            "Revision: \(policy.revision)"
        ].joined(separator: "\n")
    }

    // MARK: - Actions

    func requestActiveProjectEnrollment() {
        guard let project = activeBrowseOnlyProject, enrollingProjectID == nil else { return }
        projectPendingEnrollment = project
    }

    func enrollPendingProject() {
        guard let project = projectPendingEnrollment,
              project.allowedPaths.isEmpty,
              enrollingProjectID == nil,
              let api else { return }
        enrollingProjectID = project.id
        Task {
            do {
                try await authenticateUser(
                    reason: "Allow EXARCH agent harnesses to work in \(project.repoRoot)."
                )
                try await enrollment.enrollProject(project)
                projects = try await api.get("/api/v1/projects", as: [Project].self)
                    .sorted { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }
                guard let confirmed = projects.first(where: { $0.id == project.id }),
                      confirmed.allowedPaths == [project.repoRoot] else {
                    throw ExarchError.unavailable(
                        "The local service did not confirm the exact project scope"
                    )
                }
                selectedProjectID = project.id
                projectPendingEnrollment = nil
                lastSyncError = nil
                persistIndex()
            } catch {
                errorMessage = "Project enrollment was not completed. \(describe(error))"
            }
            enrollingProjectID = nil
        }
    }

    func send() {
        let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty, !busy, let api, let conversation = activeConversation else { return }
        if let project = activeBrowseOnlyProject {
            projectPendingEnrollment = project
            return
        }
        guard availableProviders.contains(provider) else {
            errorMessage = providerUnavailableMessage(provider)
            return
        }
        let sendingProvider = provider
        let selectedModel = modelName.trimmingCharacters(in: .whitespacesAndNewlines)
        if !selectedModel.isEmpty,
           selectedModel.range(of: #"^[A-Za-z0-9._:/-]{1,200}$"#, options: .regularExpression) == nil {
            errorMessage = "Model names may contain letters, numbers, dot, dash, underscore, slash, or colon."
            return
        }

        let clientMessageID = "message_\(UUID().uuidString.lowercased())"
        pendingOutgoingMessage = ConversationProjection.pendingUserMessage(
            clientMessageID: clientMessageID,
            text: text,
            provider: sendingProvider
        )
        turnStatus = ConversationTurnStatus(clientMessageID: clientMessageID, phase: .working)
        let turnStartedAt = Date()
        draft = ""
        busy = true
        userRequestedInterrupt = false
        activeTurnConversationID = conversation.id
        Task {
            var automaticFallbackProvider: Provider?
            do {
                let policy = try await refreshPolicy(
                    sendingProvider,
                    conversationID: conversation.id
                )
                var request = SubmitMessage(
                    clientMessageId: clientMessageID,
                    text: text,
                    provider: sendingProvider,
                    model: selectedModel.isEmpty ? nil : selectedModel,
                    effectivePolicyRevision: policy.revision
                )
                let result: SubmitResult
                do {
                    result = try await api.post(
                        "/api/v1/conversations/\(conversation.id)/messages",
                        input: request,
                        as: SubmitResult.self
                    )
                } catch let conflict as RemoteAPIError
                    where conflict.code == "policy_revision_conflict"
                        && conflict.retrySafe {
                    guard let currentPolicy = conflict.policy else { throw conflict }
                    cachePolicy(currentPolicy, for: sendingProvider)
                    request = SubmitMessage(
                        clientMessageId: clientMessageID,
                        text: text,
                        provider: sendingProvider,
                        model: selectedModel.isEmpty ? nil : selectedModel,
                        effectivePolicyRevision: currentPolicy.revision
                    )
                    result = try await api.post(
                        "/api/v1/conversations/\(conversation.id)/messages",
                        input: request,
                        as: SubmitResult.self
                    )
                }
                if activeConversation?.id == conversation.id { merge(result.events) }
                pendingOutgoingMessage = nil
                turnStatus = ConversationTurnStatus(
                    clientMessageID: clientMessageID,
                    phase: .completed(Date().timeIntervalSince(turnStartedAt))
                )
                try? await refreshProviderSnapshots()
            } catch {
                if activeConversation?.id == conversation.id { try? await refreshNewMessages(conversation.id) }
                let accepted = ConversationProjection.containsUserMessage(
                    clientMessageID: clientMessageID,
                    in: events
                )
                if !userRequestedInterrupt {
                    if let remote = error as? RemoteAPIError,
                       remote.code == "provider_capacity_exhausted",
                       let capacity = remote.capacity,
                       let failedProvider = remote.provider {
                        updateCapacity(capacity)
                        if remote.retrySafe && !accepted { draft = text }
                        pendingCapacityFailure = DesktopCapacityFailure(
                            provider: failedProvider,
                            capacity: capacity,
                            retrySafe: remote.retrySafe,
                            text: text
                        )
                        if remote.retrySafe && !accepted {
                            automaticFallbackProvider = nextFallback(
                                after: failedProvider,
                                in: conversation
                            )
                        }
                    } else {
                        if !accepted { draft = text }
                        errorMessage = describe(error)
                    }
                } else if !accepted {
                    draft = text
                }
                pendingOutgoingMessage = nil
                turnStatus = nil
            }
            userRequestedInterrupt = false
            activeTurnConversationID = nil
            busy = false
            interrupting = false
            if let automaticFallbackProvider {
                resolveCapacityFailure(switchingTo: automaticFallbackProvider)
            }
        }
    }

    private func nextFallback(after failedProvider: Provider, in conversation: Conversation) -> Provider? {
        guard let candidate = conversation.nextFallback(after: failedProvider) else { return nil }
        return availableProviders.contains(candidate) ? candidate : nil
    }

    func interrupt() {
        guard busy, !interrupting, let api, let conversationID = activeTurnConversationID else { return }
        interrupting = true
        userRequestedInterrupt = true
        Task {
            do {
                let result: AcceptedResult = try await api.post(
                    "/api/v1/conversations/\(conversationID)/interrupt",
                    input: EmptyRequest(),
                    as: AcceptedResult.self
                )
                if !result.accepted { throw ExarchError.invalidPayload("Laptop did not accept interruption") }
            } catch {
                userRequestedInterrupt = false
                errorMessage = describe(error)
            }
            interrupting = false
        }
    }

    func selectProvider(_ next: Provider) {
        guard next != provider, let api, let conversation = activeConversation, !busy else { return }
        guard availableProviders.contains(next) else {
            errorMessage = providerUnavailableMessage(next)
            return
        }
        busy = true
        Task {
            do {
                let handoff: [CanonicalEvent] = try await api.post(
                    "/api/v1/conversations/\(conversation.id)/provider",
                    input: SwitchProvider(provider: next),
                    as: [CanonicalEvent].self
                )
                provider = next
                modelName = ""
                merge(handoff)
                try await refreshPolicy(next, conversationID: conversation.id)
                try await refreshConversationIndex()
            } catch {
                errorMessage = describe(error)
            }
            busy = false
        }
    }

    func setFallbackRoute(_ route: [Provider]) {
        guard let api, let conversation = activeConversation, !busy else { return }
        Task {
            do {
                let updated: Conversation = try await api.post(
                    "/api/v1/conversations/\(conversation.id)/fallback-route",
                    input: FallbackRouteRequest(route: route),
                    as: Conversation.self
                )
                replaceConversation(updated)
            } catch {
                errorMessage = "The fallback route could not be updated. \(describe(error))"
            }
        }
    }

    func resolveCapacityFailure(switchingTo selected: Provider?) {
        guard let failure = pendingCapacityFailure else { return }
        guard let selected else {
            pendingCapacityFailure = nil
            return
        }
        guard let api, let conversation = activeConversation, !busy,
              availableProviders.contains(selected) else { return }
        pendingCapacityFailure = nil
        busy = true
        Task {
            do {
                let handoff: [CanonicalEvent] = try await api.post(
                    "/api/v1/conversations/\(conversation.id)/provider",
                    input: SwitchProvider(provider: selected),
                    as: [CanonicalEvent].self
                )
                provider = selected
                modelName = ""
                merge(handoff)
                try await refreshPolicy(selected, conversationID: conversation.id)
                busy = false
                if failure.retrySafe {
                    draft = failure.text
                    send()
                }
            } catch {
                busy = false
                if failure.retrySafe { draft = failure.text }
                errorMessage = describe(error)
            }
        }
    }

    func resolveApproval(_ choice: String) {
        guard let approval = pendingApproval, let api, let deviceID = localDeviceID, !busy
        else { return }
        busy = true
        Task {
            do {
                let signer = try await keyManager.signer(for: .approval)
                let decision = try await ApprovalDecisionSigner(deviceID: deviceID, signer: signer)
                    .sign(approval: approval, choice: choice)
                let _: Approval = try await api.post(
                    "/api/v1/approvals/\(approval.id)/decision",
                    input: decision,
                    as: Approval.self
                )
                pendingApproval = nil
            } catch {
                errorMessage = describe(error)
            }
            busy = false
        }
    }

    func createConversation() {
        let title = newConversationTitle.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !title.isEmpty, let projectID = selectedProjectID, let api, !busy else { return }
        guard availableProviders.contains(provider) else {
            errorMessage = providerUnavailableMessage(provider)
            return
        }
        busy = true
        Task {
            do {
                let created: Conversation = try await api.post(
                    "/api/v1/conversations",
                    input: CreateConversation(projectId: projectID, title: title, provider: provider),
                    as: Conversation.self
                )
                newConversationTitle = ""
                showNewConversation = false
                try await refreshConversationIndex()
                busy = false
                await select(created)
            } catch {
                busy = false
                errorMessage = describe(error)
            }
        }
    }

    func togglePin(_ conversation: Conversation) {
        guard let api else { return }
        let desired = !(conversation.pinned || legacyPinnedIDs.contains(conversation.id))
        Task {
            do {
                let updated: Conversation = try await api.post(
                    "/api/v1/conversations/\(conversation.id)/pin",
                    input: PinConversation(pinned: desired),
                    as: Conversation.self
                )
                legacyPinnedIDs.remove(conversation.id)
                replaceConversation(updated)
            } catch {
                errorMessage = "The pin could not be updated. \(describe(error))"
            }
        }
    }

    // MARK: - Pairing

    func unpairPhone() {
        guard pairedPhone != nil, !busy else { return }
        busy = true
        Task {
            do {
                try await authenticateUser(reason: "Remove the paired phone and retire its private relay route.")
                try await enrollment.unpair()
                knownDevices.removeAll { $0.capabilities.contains("mobile-control") }
                if let refreshed = try? await enrollment.listDevices() {
                    knownDevices = refreshed
                }
                let restartSucceeded = await Self.restartLocalService() == 0
                if restartSucceeded {
                    try? await Task.sleep(for: .seconds(1))
                    retry()
                } else {
                    errorMessage = "Pairing was removed, but the local service could not restart automatically."
                }
            } catch {
                errorMessage = "Pairing was not removed. \(describe(error))"
            }
            busy = false
            showUnpairConfirmation = false
        }
    }

    private func migrateLegacyPins(using api: RemoteAPIClient) async throws {
        let validIDs = Set(conversations.map(\.id))
        legacyPinnedIDs.formIntersection(validIDs)
        for id in legacyPinnedIDs.sorted() {
            guard let conversation = conversations.first(where: { $0.id == id }),
                  !conversation.pinned else { continue }
            let updated: Conversation = try await api.post(
                "/api/v1/conversations/\(id)/pin",
                input: PinConversation(pinned: true),
                as: Conversation.self
            )
            replaceConversation(updated)
        }
        legacyPinnedIDs = []
        UserDefaults.standard.removeObject(forKey: Self.pinnedKey)
    }

    private func replaceConversation(_ updated: Conversation) {
        if let index = conversations.firstIndex(where: { $0.id == updated.id }) {
            conversations[index] = updated
        } else {
            conversations.append(updated)
        }
        conversations.sort(by: recency)
        persistIndex()
        if activeConversation?.id == updated.id { activeConversation = updated }
    }

    nonisolated private static func restartLocalService() async -> Int32 {
        await Task.detached {
            let process = Process()
            process.executableURL = URL(fileURLWithPath: "/bin/launchctl")
            process.arguments = ["kickstart", "-k", "gui/\(getuid())/com.teempai.exarch.daemon"]
            process.standardOutput = FileHandle.nullDevice
            process.standardError = FileHandle.nullDevice
            do {
                try process.run()
                process.waitUntilExit()
                return process.terminationStatus
            } catch { return -1 }
        }.value
    }

    private func authenticateUser(reason: String) async throws {
        let context = LAContext()
        context.localizedCancelTitle = "Cancel"
        guard try await context.evaluatePolicy(.deviceOwnerAuthentication, localizedReason: reason) else {
            throw ExarchError.authenticationFailed
        }
    }

    private func describe(_ error: Error) -> String {
        if let exarch = error as? ExarchError {
            switch exarch {
            case let .invalidPayload(message), let .unavailable(message): return message
            default: return "\(exarch)"
            }
        }
        if let api = error as? RemoteAPIError { return api.description }
        return error.localizedDescription
    }

    private func providerUnavailableMessage(_ provider: Provider) -> String {
        snapshots.first(where: { $0.health.provider == provider })?.health.unavailableMessage
            ?? "\(provider.displayName) status has not been received from the EXARCH service yet. Wait for sync, then try again."
    }
}

private struct SubmitMessage: Encodable, Sendable {
    let clientMessageId: String
    let text: String
    let provider: Provider
    let model: String?
    let effectivePolicyRevision: String
}

private struct SubmitResult: Decodable, Sendable {
    let conversationId: String
    let turnId: String
    let fromSequence: Int
    let toSequence: Int
    let events: [CanonicalEvent]
}

private struct SwitchProvider: Encodable, Sendable { let provider: Provider }
private struct PinConversation: Encodable, Sendable { let pinned: Bool }
private struct FallbackRouteRequest: Encodable, Sendable { let route: [Provider] }
private struct EmptyRequest: Encodable, Sendable {}
private struct AcceptedResult: Decodable, Sendable { let accepted: Bool }
private struct CreateConversation: Encodable, Sendable {
    let projectId: String
    let title: String
    let provider: Provider
}
#endif
