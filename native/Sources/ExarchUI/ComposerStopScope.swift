import Foundation

/// What a Stop control stops.
///
/// Voice mode has its own Stop, which used to cancel only the local speech and
/// recording loop. If the turn it submitted was still running on the laptop,
/// the user had no way to interrupt it: the text composer's stop button is not
/// on screen in voice mode, and the toolbar no longer carries Interrupt. Voice
/// Stop therefore has to reach the remote turn as well whenever one is running.
///
/// Expressed as a value so the rule can be tested without driving the view.
public struct ComposerStopScope: Equatable, Sendable {
    /// End the local speech recognition and playback loop.
    public let stopsVoice: Bool
    /// Ask the laptop to interrupt the turn it is running.
    public let stopsRemoteTurn: Bool

    public init(stopsVoice: Bool, stopsRemoteTurn: Bool) {
        self.stopsVoice = stopsVoice
        self.stopsRemoteTurn = stopsRemoteTurn
    }

    /// The text composer's button, which only appears as Stop while a turn runs.
    public static func text(busy: Bool) -> ComposerStopScope {
        ComposerStopScope(stopsVoice: false, stopsRemoteTurn: busy)
    }

    /// The voice row's button, which always ends the local loop and also
    /// interrupts the laptop when a turn is in flight.
    public static func voice(busy: Bool) -> ComposerStopScope {
        ComposerStopScope(stopsVoice: true, stopsRemoteTurn: busy)
    }

    /// Names what will actually happen, so VoiceOver does not say "Stop" for
    /// two materially different outcomes.
    public var accessibilityLabel: String {
        switch (stopsVoice, stopsRemoteTurn) {
        case (true, true): "Stop voice and interrupt the running turn"
        case (true, false): "Stop voice"
        case (false, true): "Interrupt the running turn"
        case (false, false): "Stop"
        }
    }
}
