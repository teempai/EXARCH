import Testing
@testable import ExarchUI

@Suite("Composer stop scope")
struct ComposerStopScopeTests {
    /// The regression this exists for: voice Stop used to call only
    /// `stopVoice()`, so a turn submitted by voice and still running on the
    /// laptop could not be interrupted from anywhere in the interface.
    @Test("voice stop interrupts the laptop while a turn is running")
    func voiceStopReachesTheLaptop() {
        let running = ComposerStopScope.voice(busy: true)
        #expect(running.stopsVoice)
        #expect(running.stopsRemoteTurn)
    }

    @Test("voice stop only ends the local loop when no turn is running")
    func voiceStopIsLocalWhenIdle() {
        let idle = ComposerStopScope.voice(busy: false)
        #expect(idle.stopsVoice)
        #expect(!idle.stopsRemoteTurn)
    }

    @Test("the text composer never cancels voice, and only stops a running turn")
    func textStop() {
        #expect(ComposerStopScope.text(busy: true) == ComposerStopScope(stopsVoice: false, stopsRemoteTurn: true))
        #expect(ComposerStopScope.text(busy: false) == ComposerStopScope(stopsVoice: false, stopsRemoteTurn: false))
    }

    @Test("each scope announces what it will actually do")
    func labelsAreDistinct() {
        let labels = [
            ComposerStopScope.voice(busy: true).accessibilityLabel,
            ComposerStopScope.voice(busy: false).accessibilityLabel,
            ComposerStopScope.text(busy: true).accessibilityLabel
        ]
        #expect(Set(labels).count == labels.count)
        #expect(ComposerStopScope.voice(busy: true).accessibilityLabel.contains("interrupt"))
    }
}
