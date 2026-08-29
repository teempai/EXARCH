import ExarchFoundation
import SwiftUI
#if canImport(AppKit)
import AppKit
#elseif canImport(UIKit)
import UIKit
#endif

public struct FocusFlowConversationView: View {
    @Binding private var provider: Provider
    @Binding private var modelName: String
    @Binding private var voiceEnabled: Bool
    @Binding private var draft: String
    private let title: String
    private let policyLabel: String
    private let policyDetails: String
    private let capacity: ProviderCapacity?
    private let models: [ProviderModel]
    private let messages: [ChatMessage]
    private let historyError: String?
    private let isLoadingMessages: Bool
    private let isLoadingOlderMessages: Bool
    private let canLoadOlderMessages: Bool
    private let availableProviders: Set<Provider>
    private let fallbackRoute: [Provider]
    private let voiceStatus: String
    private let voiceTranscript: String
    private let busy: Bool
    private let interrupting: Bool
    private let turnStatus: ConversationTurnStatus?
    private let messageFontSize: CGFloat
    /// Widest the transcript column is allowed to get, in points.
    ///
    /// `nil` leaves it unconstrained, which is what a phone wants: the device
    /// is already narrower than a comfortable measure. A Mac window is not, so
    /// the Mac passes a value and the reading column stops growing with the
    /// window while the composer beneath it does not.
    private let transcriptMaxWidth: CGFloat?
    private let usesMinimalComposer: Bool
    /// Voice needs a speech session the Mac client does not have yet, so the
    /// mode switch is hidden rather than shown inert.
    private let supportsVoice: Bool
    private let back: (() -> Void)?
    private let send: () -> Void
    private let interrupt: () -> Void
    private let toggleVoice: (Bool) -> Void
    private let stopVoice: () -> Void
    private let loadOlderMessages: () -> Void
    private let retryMessages: () -> Void
    private let setFallbackRoute: ([Provider]) -> Void
    @State private var showingSettings = false
    @State private var pendingProvider: Provider?
    @State private var followingLatest = true
    private let latestMessageAnchor = "exarch:latest-message"

    public init(
        title: String,
        provider: Binding<Provider>,
        modelName: Binding<String>,
        policyLabel: String,
        policyDetails: String,
        capacity: ProviderCapacity?,
        models: [ProviderModel],
        messages: [ChatMessage],
        historyError: String?,
        isLoadingMessages: Bool,
        isLoadingOlderMessages: Bool,
        canLoadOlderMessages: Bool,
        availableProviders: Set<Provider>,
        fallbackRoute: [Provider],
        voiceStatus: String,
        voiceTranscript: String,
        voiceEnabled: Binding<Bool>,
        draft: Binding<String>,
        busy: Bool,
        interrupting: Bool,
        turnStatus: ConversationTurnStatus?,
        messageFontSize: CGFloat = 16,
        transcriptMaxWidth: CGFloat? = nil,
        usesMinimalComposer: Bool = false,
        supportsVoice: Bool = true,
        back: (() -> Void)? = nil,
        send: @escaping () -> Void,
        interrupt: @escaping () -> Void,
        toggleVoice: @escaping (Bool) -> Void,
        stopVoice: @escaping () -> Void,
        loadOlderMessages: @escaping () -> Void,
        retryMessages: @escaping () -> Void,
        setFallbackRoute: @escaping ([Provider]) -> Void
    ) {
        self.title = title
        _provider = provider
        _modelName = modelName
        self.policyLabel = policyLabel
        self.policyDetails = policyDetails
        self.capacity = capacity
        self.models = models
        self.messages = messages
        self.historyError = historyError
        self.isLoadingMessages = isLoadingMessages
        self.isLoadingOlderMessages = isLoadingOlderMessages
        self.canLoadOlderMessages = canLoadOlderMessages
        self.availableProviders = availableProviders
        self.fallbackRoute = fallbackRoute
        self.voiceStatus = voiceStatus
        self.voiceTranscript = voiceTranscript
        _voiceEnabled = voiceEnabled
        _draft = draft
        self.busy = busy
        self.interrupting = interrupting
        self.turnStatus = turnStatus
        self.messageFontSize = messageFontSize
        self.transcriptMaxWidth = transcriptMaxWidth
        self.usesMinimalComposer = usesMinimalComposer
        self.supportsVoice = supportsVoice
        self.back = back
        self.send = send
        self.interrupt = interrupt
        self.toggleVoice = toggleVoice
        self.stopVoice = stopVoice
        self.loadOlderMessages = loadOlderMessages
        self.retryMessages = retryMessages
        self.setFallbackRoute = setFallbackRoute
    }

    public var body: some View {
        // Capture this once for the render pass. Looking it up through a
        // computed property inside every ForEach row would rescan the full
        // transcript for every message as lazy-loaded history grows.
        let attributedMessageIDs = harnessAttributionPoints(in: messages)
        return VStack(spacing: 0) {
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(spacing: 18) {
                        historyBoundary
                        ForEach(messages) { message in
                            VStack(spacing: 8) {
                                messageRow(message, attributed: attributedMessageIDs.contains(message.id))
                                if message.role == .user,
                                   message.clientMessageID == turnStatus?.clientMessageID {
                                    turnStatusRow
                                }
                            }
                                .id(message.id)
                        }
                        Color.clear
                            .frame(height: 1)
                            .id(latestMessageAnchor)
                            .onAppear { followingLatest = true }
                            .onDisappear { followingLatest = false }
                    }
                    .padding(.horizontal, 18)
                    .padding(.vertical, 22)
                    // Left-anchored rather than centred, so the column stays
                    // put against the sidebar while the window is resized
                    // instead of drifting away from it.
                    .frame(maxWidth: transcriptMaxWidth ?? .infinity, alignment: .leading)
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
                .defaultScrollAnchor(.bottom)
                .onChange(of: messages.map(\.id)) {
                    // Preserve the user's reading position when they have
                    // scrolled up. If they are following the latest message —
                    // or just sent one locally — keep the stable bottom anchor
                    // visible without an animation that makes the transcript
                    // appear to bounce during reconciliation.
                    guard followingLatest || messages.last?.id.hasPrefix("pending:") == true else { return }
                    proxy.scrollTo(latestMessageAnchor, anchor: .bottom)
                }
            }
            composer
        }
        .background(FocusFlowTheme.canvas.ignoresSafeArea())
        .foregroundStyle(FocusFlowTheme.ink)
#if os(iOS)
        // The mobile app owns its navigation state and header in SwiftUI. It
        // deliberately has no wrapping UIKit navigation controller: iOS 26
        // can assert or stop drawing while wrapped bars are being reparented.
        .safeAreaInset(edge: .top, spacing: 0) {
            iOSConversationHeader
        }
#else
        // Title, harness, and settings live in the navigation bar that is
        // already on screen, rather than in a second bar beneath it.
        .toolbar {
            ToolbarItem(placement: .principal) {
                conversationTitle
            }
            ToolbarItemGroup(placement: .primaryAction) {
                harnessMenu
                Button {
                    showingSettings = true
                } label: {
                    Image(systemName: "slider.horizontal.3")
                }
                .accessibilityLabel("Conversation settings")
            }
        }
#endif
        .sheet(isPresented: $showingSettings) {
            NavigationStack {
                Form {
                    Section("Model") {
                        Picker("Model", selection: $modelName) {
                            Text("Laptop default").tag("")
                            ForEach(modelChoices) { model in
                                Text(model.displayName).tag(model.id)
                            }
                        }
                        if let description = selectedModelDescription {
                            Text(description)
                                .font(.caption)
                                .foregroundStyle(FocusFlowTheme.secondaryInk)
                        } else {
                            Text("Uses the model configured by \(provider.displayName) on your laptop.")
                                .font(.caption)
                                .foregroundStyle(FocusFlowTheme.secondaryInk)
                        }
                    }

                    Section("Laptop policy") {
                        Text(policyLabel)
                            .font(.subheadline.weight(.semibold))
                        Text(policyDetails)
                            .font(.system(.caption, design: .monospaced))
                            .textSelection(.enabled)
                        Text("Observed only. The phone cannot change or override it.")
                            .font(.caption)
                            .foregroundStyle(FocusFlowTheme.secondaryInk)
                    }

                    Section("Fallback route") {
                        Text(fallbackRoute.count > 1
                             ? fallbackRoute.map(\.displayName).joined(separator: " → ")
                             : "Automatic fallback is off")
                            .font(.subheadline.weight(.semibold))
                        Text("EXARCH moves only when the current harness reports exhausted capacity before provider work begins.")
                            .font(.caption)
                            .foregroundStyle(FocusFlowTheme.secondaryInk)

                        ForEach(Array(fallbackRoute.enumerated()), id: \.element) { index, candidate in
                            HStack(spacing: 10) {
                                Text("\(index + 1)")
                                    .font(.caption.monospacedDigit())
                                    .foregroundStyle(FocusFlowTheme.secondaryInk)
                                    .frame(width: 18)
                                Text(candidate.displayName)
                                if candidate == provider {
                                    Text("Current")
                                        .font(.caption2.weight(.semibold))
                                        .foregroundStyle(FocusFlowTheme.accent)
                                }
                                Spacer()
                                Button {
                                    moveFallback(at: index, by: -1)
                                } label: {
                                    Image(systemName: "arrow.up")
                                }
                                .buttonStyle(.borderless)
                                .disabled(index == 0)
                                Button {
                                    moveFallback(at: index, by: 1)
                                } label: {
                                    Image(systemName: "arrow.down")
                                }
                                .buttonStyle(.borderless)
                                .disabled(index == fallbackRoute.count - 1)
                                Button(role: .destructive) {
                                    removeFallback(candidate)
                                } label: {
                                    Image(systemName: "minus.circle")
                                }
                                .buttonStyle(.borderless)
                                .disabled(candidate == provider || fallbackRoute.count == 1)
                            }
                        }

                        if fallbackRoute.count < Provider.allCases.count {
                            Menu {
                                ForEach(Provider.allCases.filter { !fallbackRoute.contains($0) }) { candidate in
                                    Button(candidate.displayName) {
                                        setFallbackRoute(fallbackRoute + [candidate])
                                    }
                                }
                            } label: {
                                Label("Add fallback", systemImage: "plus")
                            }
                        }
                    }

                    if provider == .codex || provider == .claude {
                        Section("Subscription capacity") {
                            if let capacity, capacity.status != "not_reported" {
                                Text(capacityTitle(capacity))
                                    .font(.subheadline.weight(.semibold))
                                    .foregroundStyle(capacityTint(capacity))
                                ForEach(capacity.windows) { window in
                                    VStack(alignment: .leading, spacing: 7) {
                                        HStack {
                                            Text(window.label)
                                            Spacer()
                                            if let remaining = window.remainingPercent {
                                                Text("\(Int(remaining.rounded()))% remaining")
                                                    .foregroundStyle(FocusFlowTheme.secondaryInk)
                                            }
                                        }
                                        if let remaining = window.remainingPercent {
                                            ProgressView(value: remaining, total: 100)
                                                .tint(capacityTint(capacity))
                                        }
                                        if let reset = resetDescription(window.resetsAt) {
                                            Text(reset)
                                                .font(.caption)
                                                .foregroundStyle(FocusFlowTheme.secondaryInk)
                                        }
                                    }
                                }
                                Text(capacity.detail)
                                    .font(.caption)
                                    .foregroundStyle(FocusFlowTheme.secondaryInk)
                            } else {
                                Text(capacity?.detail ?? "This harness has not reported subscription capacity yet.")
                                    .foregroundStyle(FocusFlowTheme.secondaryInk)
                            }
                        }
                    }
                }
                .navigationTitle("Conversation settings")
                .toolbar {
                    ToolbarItem(placement: .confirmationAction) {
                        Button("Done") { showingSettings = false }
                    }
                }
            }
            .presentationDetents([.medium, .large])
        }
        .alert(
            "Switch harness?",
            isPresented: Binding(
                get: { pendingProvider != nil },
                set: { if !$0 { pendingProvider = nil } }
            ),
            presenting: pendingProvider
        ) { candidate in
            Button("Cancel", role: .cancel) { pendingProvider = nil }
            Button("Switch to \(candidate.displayName)") {
                pendingProvider = nil
                provider = candidate
            }
        } message: { candidate in
            Text("This moves the conversation context from \(provider.displayName) to \(candidate.displayName). The laptop will record the handoff before the new harness continues.")
        }
    }

#if os(iOS)
    private var iOSConversationHeader: some View {
        HStack(spacing: 10) {
            if let back {
                CircleIconButton(systemImage: "chevron.left", label: "Threads", action: back)
            }
            Text(title)
                .font(.headline)
                .lineLimit(1)
                .truncationMode(.tail)
                .frame(maxWidth: .infinity, alignment: .leading)
            harnessMenu
            Button {
                showingSettings = true
            } label: {
                Image(systemName: "slider.horizontal.3")
                    .frame(width: 32, height: 44)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Conversation settings")
        }
        .frame(height: 54)
        .padding(.horizontal, 10)
        .background(.regularMaterial)
        .overlay(alignment: .bottom) { Divider() }
    }
#endif

    private func moveFallback(at index: Int, by offset: Int) {
        let destination = index + offset
        guard fallbackRoute.indices.contains(index), fallbackRoute.indices.contains(destination) else { return }
        var route = fallbackRoute
        route.swapAt(index, destination)
        setFallbackRoute(route)
    }

    private func removeFallback(_ candidate: Provider) {
        guard candidate != provider else { return }
        setFallbackRoute(fallbackRoute.filter { $0 != candidate })
    }

    @ViewBuilder
    private var conversationTitle: some View {
#if os(macOS)
        Text(title)
            .font(.headline)
            .lineLimit(1)
            .truncationMode(.tail)
            .padding(.horizontal, 10)
            .padding(.vertical, 3)
#else
        Text(title)
            .font(.headline)
            .lineLimit(1)
            .truncationMode(.tail)
#endif
    }

    /// Capacity is a status, so it does not wear the brand colour.
    ///
    /// Without this the bar inherits `.tint(FocusFlowTheme.accent)` from the
    /// root and an exhausted subscription renders in brass, which reads as
    /// decoration rather than as a limit (docs/design/STYLE_GUIDE.md §3.2).
    /// The colour only reinforces `capacityTitle`, which already states the
    /// same thing in words.
    private func capacityTint(_ capacity: ProviderCapacity) -> Color {
        switch capacity.status {
        case "exhausted": FocusFlowTheme.danger
        case "warning": FocusFlowTheme.attention
        default: FocusFlowTheme.success
        }
    }

    private func capacityTitle(_ capacity: ProviderCapacity) -> String {
        switch capacity.status {
        case "exhausted": "Limit reached"
        case "warning": "Running low"
        case "available": "Available"
        default: "Not reported"
        }
    }

    private func resetDescription(_ value: String?) -> String? {
        guard let value else { return nil }
        let precise = ISO8601DateFormatter()
        precise.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        guard let date = precise.date(from: value) ?? ISO8601DateFormatter().date(from: value) else {
            return nil
        }
        return "Resets \(date.formatted(date: .abbreviated, time: .shortened))"
    }

    /// The harness picker, without the capsule chrome it carried in the old
    /// header. The toolbar supplies the hit area, and the chevron is what makes
    /// it read as a menu.
    private var harnessMenu: some View {
        Menu {
            ForEach(Provider.allCases) { candidate in
                Button {
                    if candidate != provider { pendingProvider = candidate }
                } label: {
                    if candidate == provider {
                        Label(candidate.displayName, systemImage: "checkmark")
                    } else {
                        Text(candidate.displayName)
                    }
                }
                .disabled(!availableProviders.contains(candidate) || busy)
            }
        } label: {
            HStack(spacing: 5) {
                Text(provider.displayName)
                    .font(.subheadline.weight(.semibold))
                    .lineLimit(1)
                Image(systemName: "chevron.down")
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(FocusFlowTheme.secondaryInk)
            }
            .foregroundStyle(FocusFlowTheme.ink)
        }
        .accessibilityLabel("Change harness")
    }

    @ViewBuilder
    private var historyBoundary: some View {
        if let historyError {
            Button(action: retryMessages) {
                Label(historyError, systemImage: "arrow.clockwise")
                    .font(.footnote)
                    .foregroundStyle(FocusFlowTheme.secondaryInk)
                    .multilineTextAlignment(.center)
            }
            .buttonStyle(.plain)
        } else if isLoadingMessages || isLoadingOlderMessages {
            HStack(spacing: 8) {
                ProgressView().controlSize(.small)
                Text(isLoadingOlderMessages ? "Loading earlier messages…" : "Loading messages…")
            }
            .font(.footnote)
            .foregroundStyle(FocusFlowTheme.secondaryInk)
        } else if canLoadOlderMessages {
            HStack(spacing: 8) {
                ProgressView().controlSize(.small)
                Text("Loading earlier messages…")
            }
            .font(.footnote)
            .foregroundStyle(FocusFlowTheme.secondaryInk)
            .onAppear(perform: loadOlderMessages)
        }
    }

    private var modelChoices: [ProviderModel] {
        guard !modelName.isEmpty, !models.contains(where: { $0.id == modelName }) else {
            return models
        }
        return [ProviderModel(id: modelName, displayName: modelName)] + models
    }

    private var selectedModelDescription: String? {
        guard !modelName.isEmpty else { return nil }
        return modelChoices.first(where: { $0.id == modelName })?.description
    }

    @ViewBuilder
    private func messageRow(_ message: ChatMessage, attributed: Bool) -> some View {
        Group {
            if message.role == .status {
                // `raised` rather than `accentSoft`. accentSoft is the accent at
                // rest — user bubbles and selected chips — so a line the system
                // emitted was drawn in the same fill as a line the user wrote, and
                // brass was carrying a status (STYLE_GUIDE.md §3.2). raised is the
                // neutral step from surface and reads as chrome, which this is.
                Text(message.text)
                    .font(.caption)
                    .foregroundStyle(FocusFlowTheme.secondaryInk)
                    .padding(.horizontal, 12)
                    .padding(.vertical, 7)
                    .background(FocusFlowTheme.raised, in: Capsule())
            } else {
                HStack {
                    if message.role == .user { Spacer(minLength: 42) }
                    VStack(alignment: .leading, spacing: 7) {
                        if message.role == .assistant, attributed, let provider = message.provider {
                            Text(provider.displayName.uppercased())
                                .font(.caption2.weight(.bold))
                                .tracking(0.7)
                                .foregroundStyle(FocusFlowTheme.accent)
                        }
                        MarkdownMessageView(message.text, fontSize: messageFontSize)
                    }
                    .padding(.horizontal, message.role == .user ? 15 : 0)
                    .padding(.vertical, message.role == .user ? 11 : 0)
                    .background(message.role == .user ? FocusFlowTheme.accentSoft : .clear, in: RoundedRectangle(cornerRadius: 18))
                    if message.role == .assistant { Spacer(minLength: 24) }
                }
                // The label is now drawn only on a change, so VoiceOver names the
                // harness on every reply rather than inheriting whatever the last
                // visible label happened to be.
                .accessibilityElement(children: .contain)
                .accessibilityLabel(spokenLabel(message))
            }
        }
        .contextMenu {
            Button {
                copyMessage(message.text)
            } label: {
                Label("Copy message", systemImage: "doc.on.doc")
            }
        }
    }

    private func copyMessage(_ text: String) {
#if canImport(UIKit)
        UIPasteboard.general.string = text
#elseif canImport(AppKit)
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(text, forType: .string)
#endif
    }

    private func spokenLabel(_ message: ChatMessage) -> String {
        guard message.role == .assistant, let provider = message.provider else { return message.text }
        return "\(provider.displayName). \(message.text)"
    }

    @ViewBuilder
    private var turnStatusRow: some View {
        HStack(spacing: 8) {
            switch turnStatus?.phase {
            case .working:
                ProgressView().controlSize(.small)
                Text("Working on your laptop…")
            case let .completed(duration):
                Image(systemName: "checkmark.circle")
                Text("Worked for \(formattedDuration(duration))")
            case nil:
                EmptyView()
            }
            Spacer()
        }
        .font(.footnote)
        .foregroundStyle(FocusFlowTheme.secondaryInk)
        .accessibilityElement(children: .combine)
    }

    private func formattedDuration(_ duration: TimeInterval) -> String {
        let seconds = max(0, Int(duration.rounded()))
        let minutes = seconds / 60
        let remainder = seconds % 60
        return minutes == 0 ? "\(remainder)s" : "\(minutes)m \(remainder)s"
    }

    private var composer: some View {
        Group {
            if usesMinimalComposer, !supportsVoice {
                minimalTextComposer
            } else {
                standardComposer
            }
        }
        .animation(.easeInOut(duration: 0.18), value: busy)
    }

    private var minimalTextComposer: some View {
        HStack(alignment: .center, spacing: 10) {
            messageTextField
                .textFieldStyle(.plain)
            primaryComposerButton
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 8)
        .frame(minHeight: 56, alignment: .center)
        .background(FocusFlowTheme.surface)
        .overlay(alignment: .top) { Divider() }
    }

    private var standardComposer: some View {
        VStack(spacing: 10) {
            if supportsVoice, voiceEnabled {
                HStack(alignment: .center, spacing: 12) {
                    Image(systemName: "waveform.circle.fill")
                        .font(.title2)
                        .foregroundStyle(FocusFlowTheme.accent)
                    VStack(alignment: .leading, spacing: 3) {
                        Text(voiceStatus)
                            .font(.subheadline.weight(.medium))
                        if !voiceTranscript.isEmpty {
                            Text(voiceTranscript)
                                .font(.caption)
                                .foregroundStyle(FocusFlowTheme.secondaryInk)
                                .lineLimit(2)
                        }
                    }
                    Spacer()
                    Button("Stop") { performStop(.voice(busy: busy)) }
                        .buttonStyle(.bordered)
                        .accessibilityLabel(ComposerStopScope.voice(busy: busy).accessibilityLabel)
                }
                .frame(minHeight: 48)
                .padding(.horizontal, 14)
                .background(FocusFlowTheme.surface, in: RoundedRectangle(cornerRadius: 18))
            } else {
                HStack(alignment: .bottom, spacing: 6) {
                    if supportsVoice { voiceButton }
                    messageTextField
                        .padding(.horizontal, supportsVoice ? 4 : 14)
                        .padding(.vertical, 12)
                    primaryComposerButton
                        .padding(4)
                }
                .background(FocusFlowTheme.surface, in: RoundedRectangle(cornerRadius: 20))
                .overlay(RoundedRectangle(cornerRadius: 20).stroke(FocusFlowTheme.border))
            }
        }
        .padding(.horizontal, 14)
        .padding(.top, 10)
        .padding(.bottom, 8)
        .background(.ultraThinMaterial)
        .animation(.easeInOut(duration: 0.18), value: voiceEnabled)
    }

    /// Enters voice mode.
    ///
    /// This replaces a permanently visible Text/Voice switch that cost a full
    /// row above the field. Voice is entered rarely and left as soon as it has
    /// produced a message, so a control inside the field is the honest weight
    /// for it — and the row it used to occupy goes back to the conversation.
    private var voiceButton: some View {
        Button {
            voiceEnabled = true
            toggleVoice(true)
        } label: {
            Image(systemName: "waveform")
                .font(.system(size: 16, weight: .medium))
                .foregroundStyle(FocusFlowTheme.secondaryInk)
                .frame(width: 44, height: 44)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(busy)
        .accessibilityLabel("Dictate a message")
        .accessibilityHint("Switches the composer to voice.")
    }

    private var messageTextField: some View {
        TextField("Message your laptop…", text: $draft, axis: .vertical)
            .lineLimit(1...6)
#if os(macOS)
            .onKeyPress { keyPress in
                guard keyPress.key == .return else { return .ignored }
                // A modified Return remains available for writing a
                // multi-line prompt. An unmodified Return mirrors the send
                // button and is consumed even when there is nothing to send.
                guard !keyPress.modifiers.contains(.shift) else { return .ignored }
                guard canSendDraft else { return .handled }
                send()
                return .handled
            }
#endif
    }

    private var canSendDraft: Bool {
        !busy && !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    /// Applies a stop scope. Both Stop controls go through here so the rule
    /// about reaching the laptop lives in one place.
    private func performStop(_ scope: ComposerStopScope) {
        if scope.stopsVoice {
            stopVoice()
            // With the mode switch gone, stopping is the way back to the field.
            voiceEnabled = false
        }
        if scope.stopsRemoteTurn { interrupt() }
    }

    /// One control that sends while idle and stops while the laptop is working.
    ///
    /// The send button is dead space during a turn — it can only be disabled,
    /// because there is nothing to send until the turn finishes. Stopping is
    /// the one thing the user may want in that moment, so it takes the slot
    /// rather than costing a second control somewhere else.
    @ViewBuilder
    private var primaryComposerButton: some View {
        if busy {
            Button {
                performStop(.text(busy: busy))
            } label: {
                Image(systemName: "stop.fill")
                    .font(.headline)
                    .foregroundStyle(FocusFlowTheme.onAccent)
                    .frame(width: 40, height: 40)
                    .background(FocusFlowTheme.accent.opacity(interrupting ? 0.5 : 1), in: Circle())
            }
            .disabled(interrupting)
            .accessibilityLabel(
                interrupting ? "Stopping" : ComposerStopScope.text(busy: busy).accessibilityLabel
            )
            .accessibilityHint("Asks your laptop to interrupt the running turn.")
            .transition(.opacity)
        } else {
            Button(action: send) {
                Image(systemName: "arrow.up")
                    .font(.headline)
                    .foregroundStyle(FocusFlowTheme.onAccent)
                    .frame(width: 40, height: 40)
                    .background(FocusFlowTheme.accent, in: Circle())
            }
            .disabled(!canSendDraft)
            .accessibilityLabel("Send message")
            .transition(.opacity)
        }
    }

}

/// Assistant messages that should carry a harness name, given the transcript.
///
/// Free rather than a method so it can be exercised without building a view.
func harnessAttributionPoints(in messages: [ChatMessage]) -> Set<String> {
    var attributed: Set<String> = []
    var previous: Provider?
    for message in messages where message.role == .assistant {
        guard let provider = message.provider else { continue }
        if provider != previous { attributed.insert(message.id) }
        previous = provider
    }
    return attributed
}
