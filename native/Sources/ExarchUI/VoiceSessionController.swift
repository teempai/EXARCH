import AVFoundation
import Combine
import ExarchFoundation
import Speech

#if os(iOS)
@MainActor
public final class VoiceSessionController: NSObject, ObservableObject {
    @Published public private(set) var state: VoiceLoopState = .text
    @Published public private(set) var partialTranscript = ""
    @Published public private(set) var unavailableReason: String?

    public var onTranscript: ((String) -> Void)?
    private var loop = VoiceLoop()
    private let recognizer = SFSpeechRecognizer()
    private let audioEngine = AVAudioEngine()
    private let synthesizer = AVSpeechSynthesizer()
    private var request: SFSpeechAudioBufferRecognitionRequest?
    private var task: SFSpeechRecognitionTask?
    private var tapInstalled = false

    public override init() {
        super.init()
        synthesizer.delegate = self
    }

    public var statusText: String {
        if let unavailableReason { return unavailableReason }
        switch state {
        case .text: return "Voice is off"
        case .idle: return "Voice is paused"
        case .listening: return "Listening…"
        case .transcribing: return "Finishing transcription…"
        case .submitting: return "Submitting…"
        case .awaitingFinal: return "Working on your laptop…"
        case .approvalBlocked: return "Waiting for your approval"
        case .speaking: return "Reading the final response…"
        }
    }

    public func setVoiceEnabled(_ enabled: Bool) async {
        if !enabled {
            cancel()
            transition(.disableVoice)
            return
        }
        transition(.enableVoice)
        let speech = await withCheckedContinuation { continuation in
            SFSpeechRecognizer.requestAuthorization { continuation.resume(returning: $0) }
        }
        let microphone = await AVAudioApplication.requestRecordPermission()
        guard speech == .authorized, microphone else {
            unavailableReason = "On-device microphone and speech access are required."
            transition(.fail)
            return
        }
        startListening()
    }

    public func speakFinal(_ exactFinalText: String) {
        stopCapture()
        transition(.finalReceived(hasText: !exactFinalText.isEmpty))
        guard state == .speaking else {
            if state == .idle { startListening() }
            return
        }
        synthesizer.speak(AVSpeechUtterance(string: SpeakableText.fromMarkdown(exactFinalText)))
    }

    public func approvalRequired() {
        stopCapture()
        synthesizer.stopSpeaking(at: .immediate)
        transition(.approvalRequired)
    }

    public func approvalResolved() { transition(.approvalResolved) }

    public func cancel() {
        stopCapture()
        synthesizer.stopSpeaking(at: .immediate)
        transition(.cancel)
    }

    private func startListening() {
        guard state == .idle || state == .listening else { return }
        guard let recognizer, recognizer.isAvailable, recognizer.supportsOnDeviceRecognition else {
            unavailableReason = "On-device speech recognition is unavailable for this language."
            transition(.fail)
            return
        }
        if state == .idle { transition(.beginListening) }
        partialTranscript = ""
        let request = SFSpeechAudioBufferRecognitionRequest()
        request.requiresOnDeviceRecognition = true
        request.shouldReportPartialResults = true
        self.request = request
        let input = audioEngine.inputNode
        let format = input.outputFormat(forBus: 0)
        input.installTap(onBus: 0, bufferSize: 1_024, format: format) { [weak request] buffer, _ in
            request?.append(buffer)
        }
        tapInstalled = true
        do {
            try AVAudioSession.sharedInstance().setCategory(.playAndRecord, mode: .spokenAudio, options: [.defaultToSpeaker])
            try AVAudioSession.sharedInstance().setActive(true)
            audioEngine.prepare()
            try audioEngine.start()
        } catch {
            unavailableReason = "The microphone could not be started."
            transition(.fail)
            return
        }
        task = recognizer.recognitionTask(with: request) { [weak self] result, error in
            Task { @MainActor in
                guard let self else { return }
                if let result {
                    self.partialTranscript = result.bestTranscription.formattedString
                    if result.isFinal {
                        if let remainder = VoiceStopCommand.remainder(
                            afterTrailingStopWordIn: self.partialTranscript
                        ) {
                            self.partialTranscript = remainder
                        }
                        self.submitRecognizedTranscript()
                    }
                } else if error != nil {
                    self.stopCapture()
                    self.transition(.fail)
                }
            }
        }
    }

    private func submitRecognizedTranscript() {
        let final = partialTranscript.trimmingCharacters(in: .whitespacesAndNewlines)
        stopCapture()
        transition(.utteranceEnded)
        guard !final.isEmpty else { transition(.fail); return }
        transition(.transcriptReady)
        onTranscript?(final)
        transition(.submitted)
    }

    private func stopCapture() {
        task?.cancel()
        task = nil
        request?.endAudio()
        request = nil
        if audioEngine.isRunning { audioEngine.stop() }
        if tapInstalled {
            audioEngine.inputNode.removeTap(onBus: 0)
            tapInstalled = false
        }
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }

    private func transition(_ event: VoiceLoopEvent) {
        state = loop.handle(event)
    }
}

extension VoiceSessionController: AVSpeechSynthesizerDelegate {
    nonisolated public func speechSynthesizer(
        _ synthesizer: AVSpeechSynthesizer,
        didFinish utterance: AVSpeechUtterance
    ) {
        Task { @MainActor in
            self.transition(.speechFinished)
            self.startListening()
        }
    }

    nonisolated public func speechSynthesizer(
        _ synthesizer: AVSpeechSynthesizer,
        didCancel utterance: AVSpeechUtterance
    ) {
        Task { @MainActor in self.transition(.cancel) }
    }
}
#endif
