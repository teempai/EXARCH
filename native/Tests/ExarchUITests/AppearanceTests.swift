import Foundation
import Testing
@testable import ExarchUI

@Suite("Appearance preference")
struct AppearanceTests {
    private func scratchDefaults(_ name: String = UUID().uuidString) -> UserDefaults {
        let defaults = UserDefaults(suiteName: name)!
        defaults.removePersistentDomain(forName: name)
        return defaults
    }

    @Test("a fresh install follows the device rather than forcing a scheme")
    @MainActor
    func defaultsToSystem() {
        let store = AppearanceStore(defaults: scratchDefaults())
        #expect(store.preference == .system)
        #expect(store.preference.colorScheme == nil)
    }

    @Test("the choice survives relaunch")
    @MainActor
    func persists() {
        let name = UUID().uuidString
        let defaults = scratchDefaults(name)
        AppearanceStore(defaults: defaults).set(.light)

        let relaunched = AppearanceStore(defaults: defaults)
        #expect(relaunched.preference == .light)
        #expect(relaunched.preference.colorScheme == .light)
    }

    @Test("the control cycles through every state and back to following the device")
    @MainActor
    func cycles() {
        let store = AppearanceStore(defaults: scratchDefaults())
        #expect(store.preference == .system)
        store.advance()
        #expect(store.preference == .light)
        store.advance()
        #expect(store.preference == .dark)
        store.advance()
        // A two-way toggle could never return here, which is why it cycles.
        #expect(store.preference == .system)
    }

    @Test("an unreadable stored value falls back to following the device")
    @MainActor
    func toleratesGarbage() {
        let name = UUID().uuidString
        let defaults = scratchDefaults(name)
        defaults.set("sepia", forKey: AppearanceStore.storageKey)
        #expect(AppearanceStore(defaults: defaults).preference == .system)
    }

    @Test("every state names itself for VoiceOver rather than naming its icon")
    func labelsDescribeState() {
        for preference in AppearancePreference.allCases {
            #expect(preference.accessibilityLabel.contains("Appearance:"))
            #expect(preference.accessibilityHint.contains(preference.next.spokenName))
            #expect(!preference.symbolName.isEmpty)
        }
    }
}
