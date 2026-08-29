import ExarchFoundation
import ExarchUI
import SwiftUI

#if os(macOS)

/// Two panes: threads and conversation. Everything else is a sheet, as it is on
/// the phone. The conversation pane is `FocusFlowConversationView` unchanged —
/// it carries no iOS-only constructs, so both clients render the same view.
struct DesktopClientView: View {
    @ObservedObject var model: DesktopClientModel
    @ObservedObject var onboarding: DesktopAppModel
    @ObservedObject private var appearance: AppearanceStore
    @State private var showingPairing = false
    @State private var showingSettings = false

    init(model: DesktopClientModel, onboarding: DesktopAppModel, appearance: AppearanceStore) {
        self.model = model
        self.onboarding = onboarding
        self.appearance = appearance
    }

    var body: some View {
        Group {
            switch model.phase {
            case .starting:
                ProgressView("Connecting to this Mac…")
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .background(FocusFlowTheme.canvas)
            case .daemonOffline:
                unavailable(
                    "EXARCH is not running",
                    detail: "The background service on this Mac is not online. Reinstall EXARCH if trying again does not start it."
                )
            case let .failed(message):
                unavailable("Could not reach this Mac", detail: message)
            case .ready:
                split
            }
        }
        .tint(FocusFlowTheme.accent)
        .task { await model.start() }
        .alert("Couldn't complete that", isPresented: Binding(
            get: { model.errorMessage != nil },
            set: { if !$0 { model.errorMessage = nil } }
        )) { Button("OK", role: .cancel) {} } message: { Text(model.errorMessage ?? "") }
        .sheet(item: $model.pendingApproval) { approval in approvalSheet(approval) }
        .sheet(isPresented: $model.showNewConversation) { newConversationSheet }
        .sheet(isPresented: $model.showUnpairConfirmation) { unpairSheet }
        .sheet(item: $model.projectPendingEnrollment) { project in
            projectEnrollmentSheet(project)
        }
        .sheet(isPresented: $showingPairing) { DesktopRootView(model: onboarding) }
        .sheet(isPresented: $showingSettings) { desktopSettingsSheet }
        .onChange(of: onboarding.pairingConfigured) { _, paired in
            guard paired else { return }
            Task {
                try? await Task.sleep(for: .seconds(2))
                model.retry()
            }
        }
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
            Button("Not now", role: .cancel) { model.resolveCapacityFailure(switchingTo: nil) }
        } message: {
            Text(capacityFailureMessage)
        }
    }

    private func unavailable(_ title: String, detail: String) -> some View {
        VStack(spacing: 14) {
            Image(systemName: "bolt.horizontal.circle")
                .font(.system(size: 34, weight: .light))
                .foregroundStyle(FocusFlowTheme.secondaryInk)
            Text(title).font(.title2.weight(.semibold))
            Text(detail)
                .font(.callout)
                .foregroundStyle(FocusFlowTheme.secondaryInk)
                .multilineTextAlignment(.center)
                .frame(maxWidth: 380)
            if model.repairingLocalService {
                ProgressView(model.identityRepairRequired ? "Repairing this Mac identity…" : "Restoring encrypted local access…")
                    .controlSize(.small)
            } else {
                Button(model.identityRepairRequired ? "Repair connection" : "Reconnect") { model.reconnect() }
                    .buttonStyle(.prominentBrass)
            }
            Text(model.identityRepairRequired
                 ? "Repair replaces only this Mac client's disconnected identity. Phone pairing and conversation history are preserved."
                 : "Reconnect checks the local service and starts it only when needed.")
                .font(.caption)
                .foregroundStyle(FocusFlowTheme.secondaryInk)
                .multilineTextAlignment(.center)
                .frame(maxWidth: 420)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(FocusFlowTheme.canvas)
    }

    private var split: some View {
        NavigationSplitView {
            sidebar
                .navigationSplitViewColumnWidth(min: 232, ideal: 252, max: 320)
        } detail: {
            if model.activeConversation != nil {
                conversation
            } else {
                emptyDetail
            }
        }
    }

    // MARK: - Sidebar

    private var sidebar: some View {
        VStack(spacing: 0) {
            VStack(spacing: 10) {
                // Only the control that acts on the list below stays up
                // here. The wordmark is set in Cinzel at 0.2em tracking and
                // needs most of a 232pt line to itself, which is the width
                // this sidebar can be dragged to.
                HStack {
                    ExarchWordmark()
                    Spacer()
                    Button { model.showNewConversation = true } label: {
                        Image(systemName: "square.and.pencil")
                    }
                    .buttonStyle(.plain)
                    .foregroundStyle(FocusFlowTheme.secondaryInk)
                    .accessibilityLabel("New conversation")
                }
                phoneRow
                if let syncError = model.lastSyncError {
                    Label("Reconnecting to local service", systemImage: "arrow.triangle.2.circlepath")
                        .font(.caption2)
                        .foregroundStyle(FocusFlowTheme.attention)
                        .help(syncError)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
            }
            .padding(.horizontal, 14)
            .padding(.top, 12)
            .padding(.bottom, 10)

            List(selection: Binding(
                get: { model.activeConversation?.id },
                set: { id in
                    guard let id, let match = model.conversations.first(where: { $0.id == id }) else { return }
                    Task { await model.select(match) }
                }
            )) {
                if !model.pinnedConversations.isEmpty {
                    Section("Pinned") {
                        ForEach(model.pinnedConversations) { threadRow($0, pinned: true) }
                    }
                }
                Section("All threads") {
                    ForEach(model.unpinnedConversations) { threadRow($0, pinned: false) }
                    if model.hasMoreThreads {
                        Button(model.isLoadingMoreThreads ? "Loading…" : "Load more") {
                            model.loadMoreThreads()
                        }
                        .buttonStyle(.plain)
                        .disabled(model.isLoadingMoreThreads)
                        .frame(maxWidth: .infinity, alignment: .center)
                        .onAppear { model.loadMoreThreads() }
                    }
                    if model.conversations.isEmpty {
                        Text(model.initialHistoryImportRunning ? "Finding threads…" : "No threads yet")
                            .foregroundStyle(FocusFlowTheme.secondaryInk)
                    }
                }
            }
            .listStyle(.sidebar)

            harnessRow
            .padding(.horizontal, 12)
            .padding(.vertical, 10)
            .overlay(alignment: .top) { Divider() }
        }
        .background(FocusFlowTheme.canvas)
    }

    /// The Mac's view of the phone, where the phone shows its view of the Mac.
    /// There is no sync state to report here: this client reads the store the
    /// daemon is writing.
    private var phoneRow: some View {
        HStack(spacing: 7) {
            Circle()
                .fill(model.pairedPhone == nil
                      ? FocusFlowTheme.secondaryInk.opacity(0.5)
                      : FocusFlowTheme.success)
                .frame(width: 7, height: 7)
            Text(model.pairedPhone?.displayName ?? "No phone paired")
                .font(.caption)
                .lineLimit(1)
                .truncationMode(.tail)
                .foregroundStyle(model.pairedPhone == nil
                                 ? FocusFlowTheme.secondaryInk
                                 : FocusFlowTheme.ink)
            Spacer(minLength: 6)
            if model.pairedPhone == nil {
                Button("Pair phone") {
                    onboarding.prepareForPairing()
                    showingPairing = true
                }
                    .buttonStyle(.plain)
                    .font(.caption.weight(.semibold))
                    .padding(.horizontal, 9)
                    .padding(.vertical, 3)
                    .background(FocusFlowTheme.accent, in: Capsule())
                    .foregroundStyle(FocusFlowTheme.onAccent)
            } else {
                Button("Unpair") { model.showUnpairConfirmation = true }
                    .buttonStyle(.plain)
                    .font(.caption)
                    .foregroundStyle(FocusFlowTheme.secondaryInk)
            }
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 6)
        .background(FocusFlowTheme.surface, in: RoundedRectangle(cornerRadius: 7))
        .overlay(RoundedRectangle(cornerRadius: 7).stroke(FocusFlowTheme.border))
    }

    /// Settings and the appearance cycle sit here rather than in the header.
    /// Both act on the application rather than on the thread list, which is
    /// what the harness readout beside them reports too. At the minimum sidebar
    /// width, the named statuses collapse into one summary menu instead of
    /// truncating provider names or crowding the controls.
    private var harnessRow: some View {
        ViewThatFits(in: .horizontal) {
            HStack(spacing: 9) {
                harnessStatuses
                Spacer(minLength: 4)
                applicationControls
            }

            HStack(spacing: 9) {
                compactHarnessMenu
                Spacer(minLength: 4)
                applicationControls
            }
        }
        .font(.caption2)
        .foregroundStyle(FocusFlowTheme.secondaryInk)
    }

    @ViewBuilder
    private var harnessStatuses: some View {
        ForEach(model.providerStatuses, id: \.provider) { health in
            HStack(spacing: 4) {
                Circle()
                    .fill(health.available ? FocusFlowTheme.success : FocusFlowTheme.danger)
                    .frame(width: 5, height: 5)
                Text(health.provider.displayName)
                    .lineLimit(1)
                    .fixedSize(horizontal: true, vertical: false)
            }
            .accessibilityLabel("\(health.provider.displayName): \(health.available ? "Ready" : "Unavailable")")
        }
    }

    private var compactHarnessMenu: some View {
        Menu {
            ForEach(model.providerStatuses, id: \.provider) { health in
                Label(
                    "\(health.provider.displayName): \(health.available ? "Ready" : "Unavailable")",
                    systemImage: health.available ? "checkmark.circle" : "exclamationmark.circle"
                )
            }
        } label: {
            Label(
                "\(model.providerStatuses.filter(\.available).count)/\(model.providerStatuses.count) harnesses",
                systemImage: "bolt.horizontal.circle"
            )
        }
        .menuStyle(.borderlessButton)
        .fixedSize(horizontal: true, vertical: false)
        .accessibilityLabel("Harness status")
    }

    private var applicationControls: some View {
        HStack(spacing: 9) {
            Button { showingSettings = true } label: {
                Image(systemName: "gearshape")
            }
            .buttonStyle(.plain)
            .accessibilityLabel("EXARCH settings")
            AppearanceButton(store: appearance)
        }
    }

    @ViewBuilder
    private var emptyDetail: some View {
        if onboarding.harnessScanPhase == .scanning || model.initialHistoryImportRunning {
            VStack(alignment: .leading, spacing: 18) {
                HStack(spacing: 12) {
                    ProgressView().controlSize(.small)
                    VStack(alignment: .leading, spacing: 3) {
                        Text("Looking for your agent harnesses").font(.title3.weight(.semibold))
                        Text("Existing threads are imported into the encrypted context on this Mac.")
                            .font(.callout)
                            .foregroundStyle(FocusFlowTheme.secondaryInk)
                    }
                }
                VStack(spacing: 0) {
                    ForEach(onboarding.harnesses) { result in
                        harnessDiscoveryRow(result)
                        if result.id != onboarding.harnesses.last?.id { Divider() }
                    }
                }
                .background(FocusFlowTheme.surface, in: RoundedRectangle(cornerRadius: 10))
                .overlay(RoundedRectangle(cornerRadius: 10).stroke(FocusFlowTheme.border))
            }
            .frame(maxWidth: 520)
            .padding(32)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(FocusFlowTheme.canvas)
        } else {
            VStack(spacing: 10) {
                Image(systemName: "bubble.left.and.bubble.right")
                    .font(.system(size: 30, weight: .light))
                    .foregroundStyle(FocusFlowTheme.secondaryInk)
                Text(model.conversations.isEmpty ? "No threads found" : "Select a thread")
                    .font(.title3.weight(.semibold))
                if model.conversations.isEmpty {
                    Text("Start a new conversation, or scan again from Settings after adding a harness.")
                        .font(.callout)
                        .foregroundStyle(FocusFlowTheme.secondaryInk)
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(FocusFlowTheme.canvas)
        }
    }

    private func harnessDiscoveryRow(_ result: HarnessScanResult) -> some View {
        HStack(spacing: 12) {
            Group {
                switch result.state {
                case .waiting:
                    Image(systemName: "circle")
                case .scanning:
                    ProgressView().controlSize(.mini)
                case .found:
                    Image(systemName: "checkmark.circle.fill").foregroundStyle(FocusFlowTheme.success)
                case .missing:
                    Image(systemName: "minus.circle").foregroundStyle(FocusFlowTheme.secondaryInk)
                }
            }
            .frame(width: 18)
            VStack(alignment: .leading, spacing: 2) {
                Text(result.provider.displayName).font(.callout.weight(.semibold))
                Text(harnessResultDetail(result))
                    .font(.caption)
                    .foregroundStyle(FocusFlowTheme.secondaryInk)
                    .lineLimit(1)
                    .truncationMode(.middle)
            }
            Spacer()
            if let imported = model.historyImportStatus?.providers.first(where: { $0.provider == result.provider }),
               imported.discovered > 0 {
                Text("\(imported.imported) threads")
                    .font(.caption)
                    .foregroundStyle(FocusFlowTheme.secondaryInk)
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 11)
    }

    private func harnessResultDetail(_ result: HarnessScanResult) -> String {
        switch result.state {
        case .waiting: "Waiting"
        case .scanning: "Searching this Mac…"
        case let .found(path): path
        case .missing: "Not found"
        }
    }

    private func threadRow(_ conversation: Conversation, pinned: Bool) -> some View {
        HStack(spacing: 8) {
            VStack(alignment: .leading, spacing: 2) {
                Text(conversation.title)
                    .font(.body.weight(conversation.id == model.activeConversation?.id ? .semibold : .regular))
                    .lineLimit(2)
                Text([conversation.activeProvider?.displayName ?? "Imported", relative(conversation.updatedAt)]
                    .joined(separator: " · "))
                    .font(.caption2)
                    .foregroundStyle(FocusFlowTheme.secondaryInk)
                    .lineLimit(1)
            }
            Spacer(minLength: 4)
            Button {
                model.togglePin(conversation)
            } label: {
                Image(systemName: pinned ? "pin.fill" : "pin")
            }
            .buttonStyle(.plain)
            .foregroundStyle(pinned ? FocusFlowTheme.accent : FocusFlowTheme.secondaryInk)
            .accessibilityLabel(pinned ? "Unpin thread" : "Pin thread")
        }
        .tag(conversation.id)
    }

    private func relative(_ value: String) -> String {
        let precise = ISO8601DateFormatter()
        precise.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let date = precise.date(from: value) ?? ISO8601DateFormatter().date(from: value)
        guard let date else { return value }
        return date.formatted(.relative(presentation: .named))
    }

    // MARK: - Conversation

    private var conversation: some View {
        VStack(spacing: 0) {
            if let project = model.activeBrowseOnlyProject {
                browseOnlyProjectBanner(project)
            }
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
                voiceStatus: "",
                voiceTranscript: "",
                voiceEnabled: $model.voiceEnabled,
                draft: $model.draft,
                busy: model.busy,
                interrupting: model.interrupting,
                turnStatus: model.turnStatus,
                messageFontSize: 12,
                transcriptMaxWidth: 640,
                usesMinimalComposer: true,
                supportsVoice: false,
                send: model.send,
                interrupt: model.interrupt,
                toggleVoice: { _ in },
                stopVoice: {},
                loadOlderMessages: model.loadOlderMessages,
                retryMessages: model.retryConversationMessages,
                setFallbackRoute: model.setFallbackRoute
            )
        }
    }

    private func browseOnlyProjectBanner(_ project: Project) -> some View {
        HStack(spacing: 10) {
            Image(systemName: "folder.badge.questionmark")
                .foregroundStyle(FocusFlowTheme.attention)
            VStack(alignment: .leading, spacing: 2) {
                Text("Browse-only project")
                    .font(.caption.weight(.semibold))
                Text(project.repoRoot)
                    .font(.caption2.monospaced())
                    .foregroundStyle(FocusFlowTheme.secondaryInk)
                    .lineLimit(1)
                    .truncationMode(.middle)
                    .help(project.repoRoot)
            }
            Spacer(minLength: 8)
            Button("Enroll this project") { model.requestActiveProjectEnrollment() }
                .buttonStyle(.bordered)
                .controlSize(.small)
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 9)
        .background(FocusFlowTheme.surface)
        .overlay(alignment: .bottom) { Divider() }
    }

    private func capacityActionLabel(_ provider: Provider) -> String {
        if model.pendingCapacityFailure?.retrySafe == true {
            return "Switch and retry with \(provider.displayName)"
        }
        return "Switch to \(provider.displayName)"
    }

    private var capacityFailureMessage: String {
        guard let failure = model.pendingCapacityFailure else { return "" }
        let action = failure.retrySafe
            ? "No provider work began, so EXARCH can safely retry the message once after the handoff."
            : "The turn may have partially run. EXARCH will switch harnesses but will not repeat the message automatically."
        return [failure.capacity.detail, action].joined(separator: "\n\n")
    }

    // MARK: - Sheets

    private var desktopSettingsSheet: some View {
        VStack(alignment: .leading, spacing: 18) {
            HStack {
                Text("Settings").font(.title2.weight(.semibold))
                Spacer()
                Button("Done") { showingSettings = false }
            }
            VStack(alignment: .leading, spacing: 8) {
                Text("Agent harnesses").font(.headline)
                Text("EXARCH searches standard local install locations and imports each harness’s native history into the laptop store.")
                    .font(.callout)
                    .foregroundStyle(FocusFlowTheme.secondaryInk)
                VStack(spacing: 0) {
                    ForEach(onboarding.harnesses) { result in
                        harnessDiscoveryRow(result)
                        if result.id != onboarding.harnesses.last?.id { Divider() }
                    }
                }
                .background(FocusFlowTheme.surface, in: RoundedRectangle(cornerRadius: 10))
                .overlay(RoundedRectangle(cornerRadius: 10).stroke(FocusFlowTheme.border))
                HStack {
                    if let status = model.historyImportStatus {
                        Text("History scan: \(status.state)")
                            .font(.caption)
                            .foregroundStyle(FocusFlowTheme.secondaryInk)
                    }
                    Spacer()
                    Button {
                        Task {
                            await onboarding.scanHarnesses()
                            await model.refreshNativeHistory()
                        }
                    } label: {
                        if onboarding.harnessScanPhase == .scanning || model.refreshingHistory {
                            ProgressView().controlSize(.small)
                        } else {
                            Label("Scan again", systemImage: "arrow.clockwise")
                        }
                    }
                    .disabled(onboarding.harnessScanPhase == .scanning || model.refreshingHistory)
                }
            }
        }
        .padding(24)
        .frame(width: 560)
        .background(FocusFlowTheme.canvas)
    }

    private func approvalSheet(_ approval: Approval) -> some View {
        VStack(alignment: .leading, spacing: 16) {
            Label("Approval requested", systemImage: "hand.raised")
                .font(.title3.weight(.semibold))
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
                .frame(maxHeight: 320)
                HStack {
                    Spacer()
                    ForEach(review.choices, id: \.self) { choice in
                        Button(choice) { model.resolveApproval(choice) }
                            .buttonStyle(.prominentBrass)
                    }
                }
            } else {
                Label("This request failed integrity verification and cannot be approved.", systemImage: "exclamationmark.triangle")
                    .foregroundStyle(FocusFlowTheme.danger)
            }
            Text("Your laptop's existing policy remains authoritative. This decision is signed with the separate approval key and may require Touch ID.")
                .font(.footnote)
                .foregroundStyle(FocusFlowTheme.secondaryInk)
        }
        .padding(24)
        .frame(width: 520)
        .background(FocusFlowTheme.canvas)
    }

    private var newConversationSheet: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("New conversation").font(.title3.weight(.semibold))
            Form {
                TextField("Title", text: $model.newConversationTitle)
                Picker("Harness", selection: $model.provider) {
                    ForEach(Provider.allCases) { candidate in
                        Text(candidate.displayName).tag(candidate)
                            .disabled(!model.availableProviders.contains(candidate))
                    }
                }
                if model.enrolledProjects.isEmpty {
                    Text("No enrolled projects. Add one with exarch-setup project-add.")
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
            .formStyle(.grouped)
            HStack {
                Spacer()
                Button("Cancel") { model.showNewConversation = false }
                Button("Create") { model.createConversation() }
                    .buttonStyle(.prominentBrass)
                    .disabled(
                        model.newConversationTitle.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                        || model.selectedProjectID == nil
                    )
            }
        }
        .padding(22)
        .frame(width: 460)
        .background(FocusFlowTheme.canvas)
    }

    private var unpairSheet: some View {
        VStack(alignment: .leading, spacing: 14) {
            Label("Unpair \(model.pairedPhone?.displayName ?? "this phone")?", systemImage: "exclamationmark.triangle")
                .font(.title3.weight(.semibold))
                .foregroundStyle(FocusFlowTheme.danger)
            Text("That phone will no longer be able to reach this Mac. EXARCH will revoke its authorization and retire the private relay route.")
                .font(.callout)
                .foregroundStyle(FocusFlowTheme.secondaryInk)
            Text("Your conversations and history stay on this Mac. The Mac client's local signed connection remains active.")
                .font(.callout)
            Text("Pairing that phone again needs a new one-time code.")
                .font(.callout)
                .foregroundStyle(FocusFlowTheme.secondaryInk)
            HStack {
                Spacer()
                Button("Cancel") { model.showUnpairConfirmation = false }
                Button("Unpair", role: .destructive) { model.unpairPhone() }
                    .buttonStyle(.borderedProminent)
                    .tint(FocusFlowTheme.danger)
            }
        }
        .padding(22)
        .frame(width: 470)
        .background(FocusFlowTheme.canvas)
    }

    private func projectEnrollmentSheet(_ project: Project) -> some View {
        VStack(alignment: .leading, spacing: 16) {
            Label("Enroll this project?", systemImage: "folder.badge.gearshape")
                .font(.title3.weight(.semibold))
            Text("This imported thread is currently browse-only. Enrolling grants local agent harnesses access to exactly this recorded directory:")
                .font(.callout)
            Text(project.repoRoot)
                .font(.system(.callout, design: .monospaced))
                .textSelection(.enabled)
                .padding(10)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(FocusFlowTheme.surface, in: RoundedRectangle(cornerRadius: 8))
                .overlay(RoundedRectangle(cornerRadius: 8).stroke(FocusFlowTheme.border))
            Text("Your harness approval and sandbox policies remain unchanged. Only this Mac can grant project scope; the phone and relay cannot.")
                .font(.footnote)
                .foregroundStyle(FocusFlowTheme.secondaryInk)
            HStack {
                Spacer()
                Button("Cancel") { model.projectPendingEnrollment = nil }
                    .disabled(model.enrollingProjectID != nil)
                if model.enrollingProjectID == project.id {
                    ProgressView("Enrolling…")
                        .controlSize(.small)
                } else {
                    Button("Enroll project") { model.enrollPendingProject() }
                        .buttonStyle(.prominentBrass)
                }
            }
        }
        .padding(22)
        .frame(width: 520)
        .background(FocusFlowTheme.canvas)
        .interactiveDismissDisabled(model.enrollingProjectID != nil)
    }

}
#endif
