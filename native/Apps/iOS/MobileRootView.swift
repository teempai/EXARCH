import ExarchFoundation
import ExarchUI
import SwiftUI

#if os(iOS)
import UIKit

struct MobileRootView: View {
    @ObservedObject var model: MobileAppModel
    @ObservedObject private var voice: VoiceSessionController
    @ObservedObject private var appearance: AppearanceStore
    @State private var showQRScanner = false
    @State private var showConversation = false
    @State private var creatingConversation = false
    @State private var confirmingPairingRemoval = false

    init(model: MobileAppModel, appearance: AppearanceStore) {
        self.model = model
        self.voice = model.voice
        self.appearance = appearance
    }

    var body: some View {
        Group {
            switch model.phase {
            case .loading:
                ProgressView("Opening your laptop connection…")
            case .needsPairing:
                pairing
            case .paired:
                if showConversation {
                    conversation
                } else {
                    threadBrowser
                }
            case let .failed(message):
                ContentUnavailableView(
                    "Connection unavailable",
                    systemImage: "laptopcomputer.trianglebadge.exclamationmark",
                    description: Text(message)
                )
            }
        }
        .onChange(of: model.activeConversation?.id) { oldValue, newValue in
            guard creatingConversation, newValue != nil, newValue != oldValue else { return }
            creatingConversation = false
            showConversation = true
        }
        .onChange(of: model.phase) { _, phase in
            guard phase != .paired else { return }
            // Navigation state belongs to one paired relationship. If that
            // relationship is removed or startup falls back to pairing, the
            // next successful pairing must open on its thread list instead of
            // resurrecting a stale conversation screen.
            showConversation = false
            creatingConversation = false
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(FocusFlowTheme.canvas.ignoresSafeArea())
        .tint(FocusFlowTheme.accent)
        .alert("Confirm this code on your Mac", isPresented: Binding(
            get: { model.pendingSAS != nil },
            set: { if !$0 { model.acceptSAS(false) } }
        )) {
            Button("Codes match") { model.acceptSAS(true) }
            Button("Cancel", role: .cancel) { model.acceptSAS(false) }
        } message: {
            Text(model.pendingSAS ?? "")
                .font(.system(.title, design: .monospaced).weight(.bold))
        }
        .alert("Couldn’t complete that", isPresented: Binding(
            get: { model.errorMessage != nil },
            set: { if !$0 { model.errorMessage = nil } }
        )) { Button("OK", role: .cancel) {} } message: { Text(model.errorMessage ?? "") }
        .confirmationDialog(
            model.pendingCapacityFailure.map { "\($0.provider.displayName) limit reached" } ?? "Limit reached",
            isPresented: Binding(
                get: { model.pendingCapacityFailure != nil },
                set: { if !$0 { model.resolveCapacityFailure(switchingTo: nil) } }
            ),
            titleVisibility: .visible
        ) {
            ForEach(model.capacityAlternatives) { candidate in
                Button(capacityActionLabel(candidate)) {
                    model.resolveCapacityFailure(switchingTo: candidate)
                }
            }
            Button("Not now", role: .cancel) {
                model.resolveCapacityFailure(switchingTo: nil)
            }
        } message: {
            Text(capacityFailureMessage)
        }
        .sheet(item: $model.pendingApproval) { approval in
            NavigationStack {
                VStack(alignment: .leading, spacing: 18) {
                    Label("Approval requested", systemImage: "hand.raised")
                        .font(.title2.weight(.semibold))
                    Text(approval.provider.displayName)
                        .font(.caption.weight(.bold))
                        .foregroundStyle(FocusFlowTheme.accent)
                    if let review = approval.verifiedReview {
                        ScrollView {
                            Text(review.details)
                                .font(.system(.body, design: .monospaced))
                                .textSelection(.enabled)
                                .frame(maxWidth: .infinity, alignment: .leading)
                        }
                        ForEach(review.choices, id: \.self) { choice in
                            Button(choice) { model.resolveApproval(choice) }
                                .buttonStyle(.prominentBrass)
                                .frame(maxWidth: .infinity)
                        }
                    } else {
                        Label("This request failed integrity verification and cannot be approved.", systemImage: "exclamationmark.triangle")
                            .foregroundStyle(FocusFlowTheme.danger)
                    }
                    Text("Your laptop’s existing policy remains authoritative. This decision is signed with the separate approval key and may require Face ID or Touch ID.")
                        .font(.footnote)
                        .foregroundStyle(FocusFlowTheme.secondaryInk)
                    Spacer()
                }
                .padding(24)
                .navigationTitle("Review action")
                .navigationBarTitleDisplayMode(.inline)
            }
            .presentationDetents([.medium, .large])
            .interactiveDismissDisabled()
        }
        .sheet(isPresented: $model.showNewConversation) {
            newConversation
        }
        .sheet(isPresented: $showQRScanner) {
            PairingQRScannerSheet { invitation in
                model.invitationText = invitation
                model.pair()
            }
        }
        .confirmationDialog(
            "Remove this Mac pairing?",
            isPresented: $confirmingPairingRemoval,
            titleVisibility: .visible
        ) {
            Button("Remove pairing", role: .destructive) { model.removePairing() }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("EXARCH will revoke this phone and its relay route, then remove the phone's local copy. Context stays encrypted on your Mac.")
        }
    }

    private var pairing: some View {
        VStack(alignment: .leading, spacing: 20) {
            Spacer()
            Image(systemName: "laptopcomputer.and.iphone")
                .font(.system(size: 38, weight: .light))
                .foregroundStyle(FocusFlowTheme.accent)
            Text("Connect your Mac")
                .font(.largeTitle.weight(.semibold))
            Text("On your Mac, create a secure connection. Scan its QR code or paste the invitation, then verify one short code on both devices.")
                .foregroundStyle(FocusFlowTheme.secondaryInk)
            HStack(spacing: 12) {
                Button("Scan QR", systemImage: "qrcode.viewfinder") {
                    showQRScanner = true
                }
                .buttonStyle(.prominentBrass)
                Button("Paste", systemImage: "doc.on.clipboard") {
                    if let invitation = UIPasteboard.general.string {
                        model.invitationText = invitation
                    }
                }
                .buttonStyle(.bordered)
            }
            .controlSize(.large)
            .disabled(model.busy)
            TextEditor(text: $model.invitationText)
                .font(.system(.caption, design: .monospaced))
                .frame(height: 130)
                .padding(10)
                .background(FocusFlowTheme.surface, in: RoundedRectangle(cornerRadius: 12))
                .overlay(RoundedRectangle(cornerRadius: 12).stroke(FocusFlowTheme.border))
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
            Button {
                model.pair()
            } label: {
                if model.busy { ProgressView().frame(maxWidth: .infinity) }
                else { Text("Connect securely").frame(maxWidth: .infinity) }
            }
            .buttonStyle(.prominentBrass)
            .disabled(model.invitationText.isEmpty || model.busy)
            Spacer()
        }
        .padding(24)
        .background(FocusFlowTheme.canvas.ignoresSafeArea())
    }

    private var conversation: some View {
        FocusFlowConversationView(
            title: model.activeConversation?.title ?? "Conversation",
            provider: Binding(get: { model.provider }, set: { model.selectProvider($0) }),
            modelName: $model.modelName,
            policyLabel: model.policyLabel,
            policyDetails: model.policyDetails,
            capacity: model.currentCapacity,
            models: model.availableModels,
            messages: model.displayedMessages,
            historyError: model.conversationLoadError,
            isLoadingMessages: model.isLoadingMessages,
            isLoadingOlderMessages: model.isLoadingOlderMessages,
            canLoadOlderMessages: model.canLoadOlderMessages,
            availableProviders: model.availableProviders,
            fallbackRoute: model.activeConversation?.fallbackRoute ?? [model.provider],
            voiceStatus: voice.statusText,
            voiceTranscript: voice.partialTranscript,
            voiceEnabled: $model.voiceEnabled,
            draft: $model.draft,
            busy: model.busy,
            interrupting: model.interrupting,
            turnStatus: model.turnStatus,
            back: { showConversation = false },
            send: model.send,
            interrupt: model.interrupt,
            toggleVoice: model.setVoice,
            stopVoice: model.stopVoice,
            loadOlderMessages: model.loadOlderMessages,
            retryMessages: model.retryConversationMessages,
            setFallbackRoute: model.setFallbackRoute
        )
    }

    private func capacityActionLabel(_ provider: Provider) -> String {
        if model.pendingCapacityFailure?.retrySafe == true {
            return "Switch and retry with \(provider.displayName)"
        }
        return "Switch to \(provider.displayName)"
    }

    private var capacityFailureMessage: String {
        guard let failure = model.pendingCapacityFailure else { return "" }
        let reset = failure.capacity.windows.compactMap(\.resetsAt).sorted().first
            .flatMap(capacityResetDescription)
        let action = failure.retrySafe
            ? "No provider work began, so EXARCH can safely retry the message once after the handoff."
            : "The turn may have partially run. EXARCH will switch harnesses but will not repeat the message automatically."
        return [failure.capacity.detail, reset, action].compactMap { $0 }.joined(separator: "\n\n")
    }

    private func capacityResetDescription(_ value: String) -> String? {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let date = formatter.date(from: value) ?? ISO8601DateFormatter().date(from: value)
        return date.map { "Next reported reset: \($0.formatted(date: .abbreviated, time: .shortened))" }
    }

    private var threadBrowser: some View {
        List {
                if !model.pinnedConversations.isEmpty {
                    Section("Pinned") {
                        ForEach(model.pinnedConversations) { conversation in
                            threadRow(conversation, pinned: true)
                        }
                    }
                }

                Section("All threads") {
                    ForEach(model.unpinnedConversations) { conversation in
                        threadRow(conversation, pinned: false)
                    }
                    if model.hasMoreThreads {
                        Button(model.isLoadingMoreThreads ? "Loading…" : "Load more") {
                            model.loadMoreThreads()
                        }
                        .disabled(model.isLoadingMoreThreads)
                        .frame(maxWidth: .infinity, alignment: .center)
                        .onAppear { model.loadMoreThreads() }
                    }
                    if model.conversations.isEmpty && !model.isSyncing {
                        ContentUnavailableView(
                            "No threads yet",
                            systemImage: "text.bubble",
                            description: Text("Create a conversation to get started.")
                        )
                    }
                }
        }
        .listStyle(.insetGrouped)
        .safeAreaInset(edge: .top, spacing: 0) {
            threadBrowserHeader
        }
    }

    private var threadBrowserHeader: some View {
        ZStack {
            // Centre the identity independently from the controls. The
            // trailing side has two buttons while the leading side has one,
            // so putting everything in one HStack shifts the mark left.
            wordmarkWithSyncState
                .frame(maxWidth: 132)

            HStack {
                Menu {
                    Section("Harnesses on this Mac") {
                        ForEach(model.providerStatuses, id: \.provider) { health in
                            Label(
                                "\(health.provider.displayName): \(health.available ? "Ready" : "Unavailable")",
                                systemImage: health.available ? "checkmark.circle" : "exclamationmark.circle"
                            )
                        }
                    }
                    Button("Remove Mac pairing", role: .destructive) {
                        confirmingPairingRemoval = true
                    }
                } label: {
                    Image(systemName: "ellipsis.circle")
                        .frame(width: 44, height: 44)
                }
                .accessibilityLabel("More")

                Spacer()

                AppearanceButton(store: appearance)
                Button {
                    beginNewConversation()
                } label: {
                    Image(systemName: "square.and.pencil")
                        .frame(width: 44, height: 44)
                }
                .accessibilityLabel("New conversation")
            }
        }
        .frame(height: 54)
        .padding(.horizontal, 6)
        .background(.regularMaterial)
        .overlay(alignment: .bottom) { Divider() }
    }

    /// The wordmark with sync state beneath it.
    ///
    /// Sync used to be a `Section` of its own, which the inset-grouped style
    /// gave a full card carrying the same weight as a thread — around sixty
    /// points held permanently above the content, to report the state the user
    /// expects by default. A header is where a view says what it is and how
    /// current it is, and this one is already 54pt tall and half empty.
    ///
    /// Sync is a status, so it keeps the status palette: `success` when
    /// settled, `attention` while catching up or retrying. Brass stays with
    /// identity, which here is the wordmark directly above it.
    private var wordmarkWithSyncState: some View {
        VStack(spacing: 1) {
            ExarchWordmark(size: 13)
            HStack(spacing: 4) {
                Image(systemName: syncUnsettled ? "arrow.triangle.2.circlepath" : "checkmark.circle.fill")
                    .font(.system(size: 9, weight: .semibold))
                Text(model.syncLabel)
                    .font(.caption2)
                    .lineLimit(1)
                    .truncationMode(.tail)
            }
            .foregroundStyle(syncUnsettled ? FocusFlowTheme.attention : FocusFlowTheme.success)
            // Chrome, not content: the header is a fixed 54pt, and the state
            // is repeated in full by the accessibility label below.
            .dynamicTypeSize(...DynamicTypeSize.xxLarge)
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel("Exarch. \(model.syncLabel)")
    }

    private var syncUnsettled: Bool {
        model.isSyncing || model.lastSyncError != nil
    }

    private func threadRow(_ conversation: Conversation, pinned: Bool) -> some View {
        HStack(spacing: 12) {
            Button {
                model.selectConversation(conversation)
                showConversation = true
            } label: {
                VStack(alignment: .leading, spacing: 5) {
                    Text(conversation.title)
                        .font(.body.weight(conversation.id == model.activeConversation?.id ? .semibold : .regular))
                        .lineLimit(2)
                        .foregroundStyle(FocusFlowTheme.ink)
                    HStack(spacing: 5) {
                        Text(conversation.activeProvider?.displayName ?? "Imported")
                        Text("·")
                        Text(threadDate(conversation.updatedAt))
                    }
                    .font(.caption)
                    .foregroundStyle(FocusFlowTheme.secondaryInk)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)

            Button(pinned ? "Unpin" : "Pin", systemImage: pinned ? "pin.fill" : "pin") {
                model.togglePin(conversation)
            }
            .labelStyle(.iconOnly)
            .buttonStyle(.borderless)
            .foregroundStyle(pinned ? FocusFlowTheme.accent : FocusFlowTheme.secondaryInk)
        }
        .swipeActions(edge: .trailing) {
            Button(pinned ? "Unpin" : "Pin") { model.togglePin(conversation) }
                .tint(FocusFlowTheme.accent)
        }
    }

    private func threadDate(_ value: String) -> String {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let date = formatter.date(from: value) ?? ISO8601DateFormatter().date(from: value)
        guard let date else { return value }
        return date.formatted(.relative(presentation: .named))
    }

    private var newConversation: some View {
        NavigationStack {
            Form {
                Section("Conversation") {
                    TextField("Title", text: $model.newConversationTitle)
                    Picker("Harness", selection: $model.provider) {
                        ForEach(Provider.allCases) { provider in
                            Text(provider.displayName).tag(provider)
                                .disabled(!model.availableProviders.contains(provider))
                        }
                    }
                }
                Section("Project on your Mac") {
                    if model.enrolledProjects.isEmpty {
                        Label("No enrolled projects", systemImage: "laptopcomputer.trianglebadge.exclamationmark")
                        Text("Add a project from EXARCH on your Mac, then sync this screen again.")
                            .font(.caption)
                            .foregroundStyle(FocusFlowTheme.secondaryInk)
                    } else {
                        Picker("Project", selection: $model.selectedProjectID) {
                            ForEach(model.enrolledProjects) { project in
                                Text(project.name).tag(project.id as String?)
                            }
                        }
                    }
                }
            }
            .navigationTitle("New conversation")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") {
                        creatingConversation = false
                        model.showNewConversation = false
                    }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Create") { model.createConversation() }
                        .disabled(
                            model.newConversationTitle.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ||
                            model.selectedProjectID == nil ||
                            model.busy
                        )
                }
            }
        }
    }

    private func beginNewConversation() {
        creatingConversation = true
        model.showNewConversation = true
    }
}
#endif
