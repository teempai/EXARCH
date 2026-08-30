import Foundation
import ExarchFoundation
import ExarchUI
#if os(iOS)
import LocalAuthentication
import UIKit
#endif

#if os(iOS)
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
/// The laptop withdraws local authorization before answering, then retires the
/// relay route after this response has crossed it.
private struct PairingRevocationResult: Decodable, Sendable {
    let accepted: Bool
    let authorizationRevoked: Bool
    let contextPreserved: Bool
}
private struct CreateConversation: Encodable, Sendable {
    let projectId: String
    let title: String
    let provider: Provider
}
struct PendingCapacityFailure: Identifiable {
    let id = UUID()
    let provider: Provider
    let capacity: ProviderCapacity
    let retrySafe: Bool
    let text: String
}

@MainActor
final class MobileAppModel: ObservableObject {
    enum Phase: Equatable { case loading, needsPairing, paired, failed(String) }

    @Published var phase: Phase = .loading
    @Published var invitationText = ""
    @Published var pendingSAS: String?
    @Published var provider: Provider = .codex
    @Published var modelName = ""
    @Published var policyLabel = "Checking laptop policy"
    @Published var policyDetails = "The laptop has not reported its policy yet."
    @Published var messages: [ChatMessage] = []
    @Published private(set) var pendingOutgoingMessage: ChatMessage?
    @Published private(set) var turnStatus: ConversationTurnStatus?
    @Published var events: [CanonicalEvent] = []
    @Published var projects: [Project] = []
    @Published var conversations: [Conversation] = []
    @Published var activeConversation: Conversation?
    @Published var draft = ""
    @Published var busy = false
    @Published var voiceEnabled = false
    @Published var errorMessage: String?
    @Published var pendingCapacityFailure: PendingCapacityFailure?
    @Published var pendingApproval: Approval?
    @Published var showNewConversation = false
    @Published var isSyncing = false
    @Published var lastSyncError: String?
    @Published var conversationLoadError: String?
    @Published private(set) var isPreparingConversation = false
    @Published var isLoadingMessages = false
    @Published var isLoadingOlderMessages = false
    @Published private(set) var isLoadingMoreThreads = false
    @Published private(set) var hasMoreThreads = true
    @Published var canLoadOlderMessages = false
    @Published var pinnedConversationIDs: Set<String> = []
    @Published var interrupting = false
    @Published var newConversationTitle = ""
    @Published var selectedProjectID: String?

    var enrolledProjects: [Project] {
        projects.filter { !$0.allowedPaths.isEmpty }
    }

    var activeBrowseOnlyProject: Project? {
        guard let projectID = activeConversation?.projectId,
              let project = projects.first(where: { $0.id == projectID }),
              project.allowedPaths.isEmpty else { return nil }
        return project
    }
    let voice = VoiceSessionController()

    private let secureStore = KeychainStore()
    private let cacheStore = MobileCacheStore()
    private let keyManager: DeviceKeyManager
    private let identityStore: LibP2PIdentityStore
    private var api: RemoteAPIClient?
    private var transport: NativeRelayTransport?
    private var snapshots: [ProviderSnapshot] = []
    private var sasContinuation: CheckedContinuation<Bool, Never>?
    private var pollTask: Task<Void, Never>?
    private var cacheWriteTask: Task<Void, Never>?
    private var pairedDeviceID: String?
    private var conversationCursor: String?
    private var threadPageCursor: String?
    private var cachedThreadBacklog: [Conversation] = []
    private var remoteHasMoreThreads = true
    private var messageWatermarks: [String: Int] = [:]
    private var needsLegacyPinMigration = false
    private var userRequestedInterrupt = false
    private var cachedConversationEvents: [CanonicalEvent] = []

    private static let initialMessageCount = 30
    private static let threadPageSize = 30

    var availableProviders: Set<Provider> {
        Set(snapshots.filter(\.health.available).map(\.health.provider))
    }

    var providerStatuses: [ProviderHealth] {
        snapshots.map(\.health)
    }

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
        conversations.filter { pinnedConversationIDs.contains($0.id) }.sorted(by: threadOrder)
    }

    var unpinnedConversations: [Conversation] {
        conversations.filter { !pinnedConversationIDs.contains($0.id) }.sorted(by: threadOrder)
    }

    var syncLabel: String {
        if isSyncing { return "Syncing with Mac…" }
        if lastSyncError != nil { return "Reconnecting to Mac…" }
        return "Up to date"
    }

    init() {
        keyManager = DeviceKeyManager(store: secureStore)
        identityStore = LibP2PIdentityStore(store: secureStore)
        voice.onTranscript = { [weak self] text in
            guard let self else { return }
            self.draft = text
            self.send()
        }
    }

    func start() async {
        guard phase == .loading else { return }
        do {
            guard let stored = try secureStore.read(account: "paired-laptop") else {
                phase = .needsPairing
                return
            }
            try await configure(try JSONDecoder().decode(PairedLaptop.self, from: stored))
        } catch {
            phase = .failed("The saved laptop connection could not be opened.")
        }
    }

    func pair() {
        guard !busy else { return }
        busy = true
        errorMessage = nil
        Task {
            do {
                let invitation = try JSONDecoder().decode(PairingInvitation.self, from: Data(invitationText.utf8))
                let requestSigner = try await keyManager.signer(for: .request)
                let approvalSigner = try await keyManager.signer(for: .approval)
                let identity = try await identityStore.identity()
                let deviceID = try persistentDeviceID()
                let client = PairingClient(
                    requestSigner: requestSigner,
                    approvalSigner: approvalSigner,
                    transportIdentity: identity
                )
                let paired = try await client.pair(
                    invitation: invitation,
                    deviceID: deviceID,
                    displayName: UIDevice.current.name
                ) { [weak self] sas in
                    guard let self else { return false }
                    return await self.confirmSAS(sas)
                }
                try secureStore.write(try JSONEncoder().encode(paired), account: "paired-laptop")
                pendingSAS = nil
                try await configure(paired)
            } catch {
                pendingSAS = nil
                let failure = pairingFailure(error)
                if failure.requiresFreshCode { invitationText = "" }
                errorMessage = failure.message
            }
            busy = false
        }
    }

    private func pairingFailure(_ error: Error) -> (message: String, requiresFreshCode: Bool) {
        let errors = underlyingErrors(error)
        if errors.contains(where: {
            $0.domain == NSURLErrorDomain && $0.code == NSURLErrorNotConnectedToInternet
        }) {
            return (
                "The connection was blocked before pairing. Allow EXARCH to connect to the relay address shown by your Mac, then create and paste a fresh pairing code.",
                true
            )
        }
        let socketClosed = errors.contains {
            ($0.domain == NSPOSIXErrorDomain && $0.code == Int(POSIXErrorCode.ENOTCONN.rawValue))
                || $0.localizedDescription.localizedCaseInsensitiveContains("socket is not connected")
        }
        if socketClosed || (error as? ExarchError) == .transportClosed {
            return (
                "That pairing connection is no longer active. Create and paste a fresh pairing code from your Mac, then try again.",
                true
            )
        }
        if case let ExarchError.invalidPayload(message) = error,
           message.localizedCaseInsensitiveContains("invitation") {
            return ("That pairing code is invalid or expired. Create a fresh one on your Mac.", true)
        }
        return (String(describing: error), false)
    }

    private func underlyingErrors(_ error: Error) -> [NSError] {
        var result: [NSError] = []
        var current: NSError? = error as NSError
        while let value = current, result.count < 8 {
            result.append(value)
            current = value.userInfo[NSUnderlyingErrorKey] as? NSError
        }
        return result
    }

    func acceptSAS(_ accepted: Bool) {
        sasContinuation?.resume(returning: accepted)
        sasContinuation = nil
        if !accepted { pendingSAS = nil }
    }

    func send() {
        let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty, let conversation = activeConversation, let api, !busy else { return }
        if let project = activeBrowseOnlyProject {
            errorMessage = "This imported thread is browse-only. Open EXARCH Desktop and enroll \(project.repoRoot) before sending a message."
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
                merge(result.events)
                pendingOutgoingMessage = nil
                turnStatus = ConversationTurnStatus(
                    clientMessageID: clientMessageID,
                    phase: .completed(Date().timeIntervalSince(turnStartedAt))
                )
                persistCurrentEvents()
                try? await refreshProviderSnapshots()
                if voiceEnabled,
                   let final = result.events.last(where: { $0.type == "assistant.message.completed" })?.visibleText {
                    voice.speakFinal(final)
                }
            } catch {
                try? await refreshNewMessages(conversation.id)
                let laptopAcceptedMessage = ConversationProjection.containsUserMessage(
                    clientMessageID: clientMessageID,
                    in: cachedConversationEvents
                )
                if !userRequestedInterrupt {
                    if let remote = error as? RemoteAPIError,
                       remote.code == "provider_capacity_exhausted",
                       let capacity = remote.capacity,
                       let failedProvider = remote.provider {
                        updateCapacity(capacity)
                        if remote.retrySafe && !laptopAcceptedMessage { draft = text }
                        pendingCapacityFailure = PendingCapacityFailure(
                            provider: failedProvider,
                            capacity: capacity,
                            retrySafe: remote.retrySafe,
                            text: text
                        )
                        if remote.retrySafe && !laptopAcceptedMessage {
                            automaticFallbackProvider = nextFallback(
                                after: failedProvider,
                                in: conversation
                            )
                        }
                    } else {
                        if !laptopAcceptedMessage { draft = text }
                        errorMessage = String(describing: error)
                    }
                } else if !laptopAcceptedMessage {
                    draft = text
                }
                pendingOutgoingMessage = nil
                turnStatus = nil
            }
            userRequestedInterrupt = false
            busy = false
            if let automaticFallbackProvider {
                resolveCapacityFailure(switchingTo: automaticFallbackProvider)
            }
        }
    }

    private func nextFallback(after failedProvider: Provider, in conversation: Conversation) -> Provider? {
        guard let candidate = conversation.nextFallback(after: failedProvider) else { return nil }
        return availableProviders.contains(candidate) ? candidate : nil
    }

    func resolveCapacityFailure(switchingTo selected: Provider?) {
        guard let failure = pendingCapacityFailure else { return }
        guard let selected else {
            pendingCapacityFailure = nil
            return
        }
        guard let conversation = activeConversation, let api, !busy,
              availableProviders.contains(selected) else { return }
        pendingCapacityFailure = nil
        busy = true
        Task {
            do {
                let events: [CanonicalEvent] = try await api.post(
                    "/api/v1/conversations/\(conversation.id)/provider",
                    input: SwitchProvider(provider: selected),
                    as: [CanonicalEvent].self
                )
                provider = selected
                modelName = ""
                merge(events)
                persistCurrentEvents()
                try await refreshPolicy(selected, conversationID: conversation.id)
                persistIndex()
                busy = false
                if failure.retrySafe {
                    draft = failure.text
                    send()
                }
            } catch {
                busy = false
                if failure.retrySafe { draft = failure.text }
                errorMessage = String(describing: error)
            }
        }
    }

    func selectProvider(_ selected: Provider) {
        guard selected != provider, let conversation = activeConversation, let api, !busy else { return }
        guard availableProviders.contains(selected) else {
            errorMessage = providerUnavailableMessage(selected)
            return
        }
        busy = true
        Task {
            do {
                let events: [CanonicalEvent] = try await api.post(
                    "/api/v1/conversations/\(conversation.id)/provider",
                    input: SwitchProvider(provider: selected),
                    as: [CanonicalEvent].self
                )
                provider = selected
                modelName = ""
                merge(events)
                persistCurrentEvents()
                try await refreshPolicy(selected, conversationID: conversation.id)
                persistIndex()
            } catch {
                errorMessage = String(describing: error)
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
                mergeConversations([updated])
                persistIndex()
            } catch {
                errorMessage = "The fallback route could not be updated. \(String(describing: error))"
            }
        }
    }

    func selectConversation(_ selected: Conversation) {
        guard selected.id != activeConversation?.id, !busy else { return }
        voice.cancel()
        isPreparingConversation = true
        activeConversation = selected
        provider = selected.activeProvider ?? .codex
        modelName = ""
        messages = []
        pendingOutgoingMessage = nil
        turnStatus = nil
        events = []
        cachedConversationEvents = []
        conversationLoadError = nil
        isLoadingMessages = true
        isLoadingOlderMessages = false
        canLoadOlderMessages = false
        pendingApproval = nil
        updatePolicyLabel()
        persistIndex()
        Task {
            let hasCachedMessages = await hydrateEventsFromCache(selected.id)
            guard activeConversation?.id == selected.id else {
                return
            }
            // A cached window is enough to reveal a stable, immediately useful
            // transcript. If this thread has not been cached yet, keep the
            // opening placeholder in place until the first authoritative page
            // arrives rather than showing an empty view and then moving it.
            if hasCachedMessages { isPreparingConversation = false }
            do {
                try await refreshRecentMessages(selected.id)
                conversationLoadError = nil
            } catch {
                conversationLoadError = "Messages couldn’t sync. Check the Mac connection and tap to retry."
                lastSyncError = String(describing: error)
            }
            // Message hydration owns the opening experience. Policy metadata
            // may arrive afterward without keeping an uncached conversation
            // behind a blank loading surface.
            if activeConversation?.id == selected.id { isPreparingConversation = false }
            do {
                try await refreshPolicy(provider, conversationID: selected.id)
            } catch {
                lastSyncError = String(describing: error)
            }
            if activeConversation?.id == selected.id {
                isLoadingMessages = false
            }
        }
    }

    func createConversation() {
        let title = newConversationTitle.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !title.isEmpty, let api, !busy else { return }
        guard availableProviders.contains(provider) else {
            errorMessage = providerUnavailableMessage(provider)
            return
        }
        guard let projectID = selectedProjectID else {
            errorMessage = "Add a project from your Mac before creating a conversation."
            return
        }
        busy = true
        Task {
            do {
                let conversation: Conversation = try await api.post(
                    "/api/v1/conversations",
                    input: CreateConversation(projectId: projectID, title: title, provider: provider),
                    as: Conversation.self
                )
                mergeConversations([conversation])
                activeConversation = conversation
                messages = []
                turnStatus = nil
                events = []
                cachedConversationEvents = []
                conversationLoadError = nil
                canLoadOlderMessages = false
                showNewConversation = false
                newConversationTitle = ""
                try await refreshPolicy(provider, conversationID: conversation.id)
                persistIndex()
            } catch {
                errorMessage = String(describing: error)
            }
            busy = false
        }
    }

    func setVoice(_ enabled: Bool) {
        voiceEnabled = enabled
        Task { await voice.setVoiceEnabled(enabled) }
    }

    func stopVoice() {
        voice.cancel()
    }

    func becameActive() {
        guard phase == .paired else { return }
        pollTask?.cancel()
        Task {
            await synchronizeFromLaptop()
            startPolling()
        }
    }

    func becameInactive() {
        stopVoice()
        pollTask?.cancel()
        pollTask = nil
    }

    func togglePin(_ conversation: Conversation) {
        guard let api else { return }
        let wasPinned = pinnedConversationIDs.contains(conversation.id)
        if wasPinned { pinnedConversationIDs.remove(conversation.id) }
        else { pinnedConversationIDs.insert(conversation.id) }
        persistIndex()
        Task {
            do {
                let updated: Conversation = try await api.post(
                    "/api/v1/conversations/\(conversation.id)/pin",
                    input: PinConversation(pinned: !wasPinned),
                    as: Conversation.self
                )
                mergeConversations([updated])
                persistIndex()
            } catch {
                if wasPinned { pinnedConversationIDs.insert(conversation.id) }
                else { pinnedConversationIDs.remove(conversation.id) }
                persistIndex()
                errorMessage = "The pin could not be updated. \(String(describing: error))"
            }
        }
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
                conversationLoadError = nil
                persistCurrentEvents()
            } catch {
                guard activeConversation?.id == conversationID else { return }
                conversationLoadError = "Earlier messages couldn’t load. Tap to retry."
                lastSyncError = String(describing: error)
            }
        }
    }

    func retryConversationMessages() {
        guard let conversation = activeConversation, !isLoadingMessages else { return }
        isLoadingMessages = true
        conversationLoadError = nil
        let conversationID = conversation.id
        Task {
            do {
                try await refreshRecentMessages(conversationID)
            } catch {
                guard activeConversation?.id == conversationID else { return }
                conversationLoadError = "Messages couldn’t sync. Check the Mac connection and tap to retry."
                lastSyncError = String(describing: error)
            }
            if activeConversation?.id == conversationID { isLoadingMessages = false }
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
                lastSyncError = String(describing: error)
            }
        }
    }

    func interrupt() {
        guard let conversation = activeConversation, let api, busy, !interrupting else { return }
        interrupting = true
        userRequestedInterrupt = true
        voice.cancel()
        Task {
            do {
                let result: AcceptedResult = try await api.post(
                    "/api/v1/conversations/\(conversation.id)/interrupt",
                    input: EmptyRequest(),
                    as: AcceptedResult.self
                )
                if !result.accepted { throw ExarchError.invalidPayload("Laptop did not accept interruption") }
            } catch {
                userRequestedInterrupt = false
                errorMessage = String(describing: error)
            }
            interrupting = false
        }
    }

    func resolveApproval(_ choice: String) {
        guard let approval = pendingApproval, let api, let deviceID = pairedDeviceID, !busy else { return }
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
                voice.approvalResolved()
            } catch {
                if let remote = error as? RemoteAPIError,
                   ["approval_expired", "approval_not_pending", "approval_delivery_failed"].contains(remote.code) {
                    pendingApproval = nil
                    voice.approvalResolved()
                    await refreshApprovals(approval.conversationId)
                    if remote.code == "approval_expired" {
                        errorMessage = "That approval expired before the decision reached your Mac. Run the action again if it is still needed."
                    } else if remote.code == "approval_delivery_failed" {
                        errorMessage = "Your decision reached the Mac, but \(approval.provider.displayName) could not accept it. The turn was stopped safely."
                    }
                    // `approval_not_pending` means the other mirrored client
                    // already resolved it. Clearing the sheet is the success
                    // path; no error alert is useful.
                } else {
                    errorMessage = String(describing: error)
                }
            }
            busy = false
        }
    }

    func removePairing() {
        guard let api, !busy else { return }
        busy = true
        errorMessage = nil
        Task {
            do {
#if !targetEnvironment(simulator)
                let context = LAContext()
                context.localizedCancelTitle = "Cancel"
                guard try await context.evaluatePolicy(
                    .deviceOwnerAuthentication,
                    localizedReason: "Remove this Mac pairing and revoke its relay route."
                ) else {
                    busy = false
                    return
                }
#endif
                let result: PairingRevocationResult = try await api.post(
                    "/api/v1/pairing/revoke",
                    input: EmptyRequest(),
                    as: PairingRevocationResult.self
                )
                guard result.accepted, result.authorizationRevoked, result.contextPreserved else {
                    throw ExarchError.invalidPayload("Laptop did not durably revoke this phone")
                }
                clearLocalPairing()
            } catch {
                errorMessage = "Pairing was not removed. \(String(describing: error))"
                busy = false
            }
        }
    }

    private func clearLocalPairing() {
        let deviceID = pairedDeviceID
        voice.cancel()
        pollTask?.cancel()
        pollTask = nil
        Task { await transport?.disconnect() }
        try? secureStore.delete(account: "paired-laptop")
        if let deviceID { try? secureStore.delete(account: "request-counter.\(deviceID)") }
        for account in ["device-id", "libp2p.ed25519", "p256.request", "p256.approval", "p256.hostIdentity"] {
            try? secureStore.delete(account: account)
        }
        if let deviceID {
            let cacheStore = cacheStore
            enqueueCacheWrite { try? cacheStore.delete(deviceID: deviceID) }
        }
        api = nil
        transport = nil
        conversations = []
        projects = []
        activeConversation = nil
        messages = []
        pendingOutgoingMessage = nil
        turnStatus = nil
        events = []
        cachedConversationEvents = []
        conversationLoadError = nil
        isPreparingConversation = false
        canLoadOlderMessages = false
        snapshots = []
        pinnedConversationIDs = []
        needsLegacyPinMigration = false
        conversationCursor = nil
        threadPageCursor = nil
        cachedThreadBacklog = []
        remoteHasMoreThreads = true
        hasMoreThreads = true
        messageWatermarks = [:]
        pairedDeviceID = nil
        lastSyncError = nil
        isSyncing = false
        busy = false
        phase = .needsPairing
    }

    private func configure(_ paired: PairedLaptop) async throws {
        pairedDeviceID = paired.deviceID
        await restoreCache(deviceID: paired.deviceID)
        let signer = try await keyManager.signer(for: .request)
        let transport = NativeRelayTransport(route: paired.route, identityStore: identityStore)
        let api = RemoteAPIClient(
            transport: transport,
            authenticator: RequestAuthenticator(deviceId: paired.deviceID, signer: signer),
            counterStore: KeychainRequestCounter(deviceID: paired.deviceID, store: secureStore)
        )
        self.transport = transport
        self.api = api
        phase = .paired
        await synchronizeFromLaptop()
        startPolling()
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
        guard let api else { throw ExarchError.unavailable("Laptop connection is unavailable") }
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

    private func merge(_ events: [CanonicalEvent]) {
        mergeIntoCache(events)
        let existingEvents = Set(self.events.map(\.id))
        self.events += events.filter { !existingEvents.contains($0.id) }
        self.events.sort { $0.sequence < $1.sequence }
        // Re-project the visible window as a whole. Besides making identity
        // reconciliation deterministic, this lets the projection collapse a
        // native-history mirror against the live event already on screen.
        messages = ConversationProjection.messages(from: self.events)
            .sorted { $0.sequence < $1.sequence }
    }

    private func mergeIntoCache(_ events: [CanonicalEvent]) {
        let existing = Set(cachedConversationEvents.map(\.id))
        cachedConversationEvents += events.filter { !existing.contains($0.id) }
        cachedConversationEvents.sort { $0.sequence < $1.sequence }
    }

    private static func isDisplayEvent(_ event: CanonicalEvent) -> Bool {
        ["user.message", "assistant.message.completed", "provider.handoff.completed"].contains(event.type)
    }

    @discardableResult
    private func refreshPolicy(_ selected: Provider, conversationID: String) async throws -> EffectivePolicy {
        guard let api else { throw ExarchError.unavailable("Laptop connection is unavailable") }
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

    private func updateCapacity(_ capacity: ProviderCapacity) {
        guard let index = snapshots.firstIndex(where: { $0.health.provider == capacity.provider }) else { return }
        snapshots[index] = ProviderSnapshot(
            health: snapshots[index].health,
            policy: snapshots[index].policy,
            models: snapshots[index].models,
            capacity: capacity
        )
        persistIndex()
    }

    private func updatePolicyLabel() {
        guard let snapshot = snapshots.first(where: { $0.health.provider == provider }) else {
            policyLabel = "Policy unavailable"
            policyDetails = "No policy observation is available for this harness."
            return
        }
        policyLabel = "Laptop policy · \(snapshot.policy.status)"
        let automatic = snapshot.policy.normalized.mayExecuteWithoutPrompt.map(String.init) ?? "provider-defined"
        policyDetails = [
            "Harness: \(snapshot.policy.provider.displayName)",
            "Status: \(snapshot.policy.status)",
            "Source: \(snapshot.policy.source)",
            "Reviewer/mode: \(snapshot.policy.normalized.reviewer ?? "provider-defined")",
            "Sandbox: \(snapshot.policy.normalized.sandbox ?? "provider-defined")",
            "May execute without prompt: \(automatic)",
            "Revision: \(snapshot.policy.revision)"
        ].joined(separator: "\n")
    }

    private func startPolling() {
        pollTask?.cancel()
        pollTask = Task { [weak self] in
            var pollCount = 0
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(2))
                guard let self else { continue }
                if let id = self.activeConversation?.id {
                    do {
                        try await self.refreshNewMessages(id)
                        self.lastSyncError = nil
                    } catch {
                        self.lastSyncError = String(describing: error)
                    }
                    // Approval state is independently laptop-owned. A message
                    // sync failure must never leave an expired or phone-decided
                    // approval stuck on screen.
                    await self.refreshApprovals(id)
                }
                do {
                    pollCount += 1
                    if pollCount.isMultiple(of: 5) {
                        try await self.refreshProviderSnapshots()
                        try await self.refreshLoadedThreadWindow()
                    }
                } catch {
                    self.lastSyncError = String(describing: error)
                }
            }
        }
    }

    private func restoreCache(deviceID: String) async {
        let cacheStore = cacheStore
        do {
            guard let index = try await Task.detached(operation: {
                try cacheStore.loadIndex(deviceID: deviceID)
            }).value else { return }
            projects = index.projects
            let cached = index.conversations.sorted(by: cacheThreadOrder)
            conversations = Array(cached.prefix(Self.threadPageSize))
            cachedThreadBacklog = Array(cached.dropFirst(Self.threadPageSize))
            snapshots = index.providerSnapshots
            conversationCursor = index.conversationCursor
            threadPageCursor = index.threadPageCursor
            remoteHasMoreThreads = index.hasMoreThreads ?? true
            hasMoreThreads = !cachedThreadBacklog.isEmpty || remoteHasMoreThreads
            messageWatermarks = index.messageWatermarks ?? [:]
            let canonicalPins = Set(conversations.filter(\.pinned).map(\.id))
            needsLegacyPinMigration = index.canonicalPins != true
            pinnedConversationIDs = needsLegacyPinMigration
                ? canonicalPins.union(index.pinnedConversationIDs)
                : canonicalPins
            selectedProjectID = enrolledProjects.first?.id
            activeConversation = index.activeConversationID
                .flatMap { id in conversations.first(where: { $0.id == id }) }
                ?? conversations.first
            if let conversation = activeConversation {
                provider = conversation.activeProvider ?? .codex
                _ = await hydrateEventsFromCache(conversation.id)
            }
            updatePolicyLabel()
        } catch {
            lastSyncError = "Saved threads could not be opened. The app will rebuild its cache."
        }
    }

    @discardableResult
    private func hydrateEventsFromCache(_ conversationID: String) async -> Bool {
        guard let deviceID = pairedDeviceID else { return false }
        let cacheStore = cacheStore
        do {
            let cached = try await Task.detached(operation: {
                try cacheStore.loadEvents(deviceID: deviceID, conversationID: conversationID)
            }).value
            guard activeConversation?.id == conversationID else { return false }
            cachedConversationEvents = cached.sorted { $0.sequence < $1.sequence }
            let displayEvents = cachedConversationEvents.filter(Self.isDisplayEvent)
            events = Array(displayEvents.suffix(Self.initialMessageCount))
            messages = ConversationProjection.messages(from: events).sorted { $0.sequence < $1.sequence }
            canLoadOlderMessages = displayEvents.count > events.count || events.count == Self.initialMessageCount
            return !messages.isEmpty
        } catch {
            guard activeConversation?.id == conversationID else { return false }
            cachedConversationEvents = []
            events = []
            messages = []
            canLoadOlderMessages = false
            lastSyncError = "This thread’s saved messages could not be opened."
            return false
        }
    }

    private func synchronizeFromLaptop() async {
        guard !isSyncing, let api else { return }
        isSyncing = true
        defer { isSyncing = false }
        do {
            // The relay carries one ordered request/response stream. Keep the
            // startup reads sequential so concurrent receives cannot consume
            // one another's response.
            snapshots = try await api.get("/api/v1/providers", as: [ProviderSnapshot].self)
            projects = try await api.get("/api/v1/projects", as: [Project].self)
            projects.sort { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }
            if !enrolledProjects.contains(where: { $0.id == selectedProjectID }) {
                selectedProjectID = enrolledProjects.first?.id
            }
            try await refreshLoadedThreadWindow()

            if activeConversation == nil, let first = conversations.first {
                activeConversation = first
                provider = first.activeProvider ?? .codex
                await hydrateEventsFromCache(first.id)
            }
            if let conversation = activeConversation {
                provider = conversation.activeProvider ?? provider
                try await refreshPolicy(provider, conversationID: conversation.id)
                if messages.isEmpty {
                    try await refreshRecentMessages(conversation.id)
                } else {
                    try await refreshNewMessages(conversation.id)
                }
                await refreshApprovals(conversation.id)
            } else if !availableProviders.contains(provider),
                      let available = Provider.allCases.first(where: availableProviders.contains) {
                provider = available
            }
            showNewConversation = conversations.isEmpty
            lastSyncError = nil
            updatePolicyLabel()
            persistIndex()
        } catch {
            lastSyncError = String(describing: error)
            updatePolicyLabel()
            persistIndex()
        }
    }

    private func refreshProviderSnapshots() async throws {
        guard let api else { throw ExarchError.unavailable("Laptop connection is unavailable") }
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
        persistIndex()
    }

    private func refreshLoadedThreadWindow() async throws {
        guard api != nil else { return }
        let legacyPins = needsLegacyPinMigration ? pinnedConversationIDs : []
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
                throw ExarchError.invalidPayload("Laptop thread pagination did not advance")
            }
            cursor = next
        } while true
        conversations = Array(refreshed.prefix(targetCount)).sorted(by: threadOrder)
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
        pinnedConversationIDs = Set(conversations.filter(\.pinned).map(\.id))
        if let id = activeConversation?.id,
           let refreshedActive = conversations.first(where: { $0.id == id }) {
            activeConversation = refreshedActive
        }
        messageWatermarks = messageWatermarks.filter { validIDs.contains($0.key) }
        persistIndex()
        await prefetchRecentMessages(for: conversations)
        if needsLegacyPinMigration {
            for id in legacyPins.intersection(validIDs).sorted() {
                guard let api else { break }
                let updated: Conversation = try await api.post(
                    "/api/v1/conversations/\(id)/pin",
                    input: PinConversation(pinned: true),
                    as: Conversation.self
                )
                mergeConversations([updated])
            }
            needsLegacyPinMigration = false
            persistIndex()
        }
    }

    private func fetchThreadPage(after cursor: String?) async throws -> ConversationListPage {
        guard let api else { throw ExarchError.unavailable("Laptop connection is unavailable") }
        var components = URLComponents()
        components.path = "/api/v1/conversations/page"
        components.queryItems = [URLQueryItem(name: "limit", value: String(Self.threadPageSize))]
        if let cursor { components.queryItems?.append(URLQueryItem(name: "cursor", value: cursor)) }
        guard let path = components.string else {
            throw ExarchError.invalidPayload("Thread pagination URL could not be created")
        }
        return try await api.get(path, as: ConversationListPage.self)
    }

    private func prefetchRecentMessages(for page: [Conversation]) async {
        guard let deviceID = pairedDeviceID else { return }
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
                lastSyncError = String(describing: error)
            }
        }
    }

    private func mergeConversations(_ updates: [Conversation]) {
        var byID = Dictionary(uniqueKeysWithValues: conversations.map { ($0.id, $0) })
        for conversation in updates {
            byID[conversation.id] = conversation
            if conversation.pinned { pinnedConversationIDs.insert(conversation.id) }
            else { pinnedConversationIDs.remove(conversation.id) }
        }
        conversations = byID.values.sorted(by: threadOrder)
        if let id = activeConversation?.id,
           let refreshed = byID[id] {
            activeConversation = refreshed
        }
        pinnedConversationIDs.formIntersection(byID.keys)
    }

    private func persistIndex() {
        guard let deviceID = pairedDeviceID else { return }
        var cachedByID = Dictionary(uniqueKeysWithValues: cachedThreadBacklog.map { ($0.id, $0) })
        for conversation in conversations { cachedByID[conversation.id] = conversation }
        let index = MobileCacheIndex(
            pairedDeviceID: deviceID,
            projects: projects,
            conversations: cachedByID.values.sorted(by: cacheThreadOrder),
            providerSnapshots: snapshots,
            conversationCursor: conversationCursor,
            threadPageCursor: threadPageCursor,
            hasMoreThreads: remoteHasMoreThreads,
            messageWatermarks: messageWatermarks,
            pinnedConversationIDs: pinnedConversationIDs.sorted(),
            canonicalPins: !needsLegacyPinMigration,
            activeConversationID: activeConversation?.id
        )
        let cacheStore = cacheStore
        enqueueCacheWrite { try? cacheStore.saveIndex(index) }
    }

    private func persistCurrentEvents() {
        guard let deviceID = pairedDeviceID,
              let conversationID = activeConversation?.id else { return }
        let currentEvents = cachedConversationEvents
        let cacheStore = cacheStore
        enqueueCacheWrite {
            try? cacheStore.saveEvents(
                currentEvents,
                deviceID: deviceID,
                conversationID: conversationID
            )
        }
    }

    private func enqueueCacheWrite(_ operation: @escaping @Sendable () -> Void) {
        let previous = cacheWriteTask
        cacheWriteTask = Task.detached {
            if let previous { await previous.value }
            operation()
        }
    }

    private func threadOrder(_ lhs: Conversation, _ rhs: Conversation) -> Bool {
        if lhs.updatedAt != rhs.updatedAt { return lhs.updatedAt > rhs.updatedAt }
        return lhs.id > rhs.id
    }

    private func cacheThreadOrder(_ lhs: Conversation, _ rhs: Conversation) -> Bool {
        if lhs.pinned != rhs.pinned { return lhs.pinned }
        return threadOrder(lhs, rhs)
    }

    private func refreshApprovals(_ conversationID: String) async {
        guard let api else { return }
        do {
            let approvals: [Approval] = try await api.get(
                "/api/v1/approvals?conversationId=\(conversationID)&status=pending",
                as: [Approval].self
            )
            let latest = approvals.first
            if pendingApproval?.id != latest?.id {
                pendingApproval = latest
                if latest != nil { voice.approvalRequired() }
            }
        } catch {
            // A transient poll failure is surfaced by the next explicit action.
        }
    }

    private func persistentDeviceID() throws -> String {
        if let data = try secureStore.read(account: "device-id"),
           let value = String(data: data, encoding: .utf8) { return value }
        let value = "device_\(UUID().uuidString.lowercased())"
        try secureStore.write(Data(value.utf8), account: "device-id")
        return value
    }

    private func providerUnavailableMessage(_ provider: Provider) -> String {
        snapshots.first(where: { $0.health.provider == provider })?.health.unavailableMessage
            ?? "\(provider.displayName) status has not been received from your Mac yet. Wait for sync, then try again."
    }

    private func confirmSAS(_ sas: String) async -> Bool {
        pendingSAS = sas
        return await withCheckedContinuation { continuation in sasContinuation = continuation }
    }
}
#endif
