import SwiftUI

/// Which appearance the user chose, and how it is remembered.
///
/// The apps used to force dark. They now support both schemes, and the choice
/// is the user's rather than the product's. `system` is the default so a fresh
/// install follows the device until the user says otherwise.
public enum AppearancePreference: String, CaseIterable, Sendable {
    case system
    case light
    case dark

    /// What to hand `.preferredColorScheme`. `nil` means "do not override".
    public var colorScheme: ColorScheme? {
        switch self {
        case .system: nil
        case .light: .light
        case .dark: .dark
        }
    }

    /// The state the appearance button moves to when tapped.
    ///
    /// A two-way toggle cannot get back to following the device once it has
    /// left, so the control cycles instead.
    public var next: AppearancePreference {
        switch self {
        case .system: .light
        case .light: .dark
        case .dark: .system
        }
    }

    public var symbolName: String {
        switch self {
        case .system: "circle.lefthalf.filled"
        case .light: "sun.max"
        case .dark: "moon"
        }
    }

    /// Spoken by VoiceOver, so it names the current state rather than the icon.
    public var accessibilityLabel: String {
        switch self {
        case .system: "Appearance: matching this device"
        case .light: "Appearance: light"
        case .dark: "Appearance: dark"
        }
    }

    public var accessibilityHint: String {
        "Switches to \(next.spokenName)."
    }

    public var spokenName: String {
        switch self {
        case .system: "matching this device"
        case .light: "light"
        case .dark: "dark"
        }
    }
}

/// Reads and writes the stored appearance.
///
/// Kept separate from the views so the persistence can be exercised directly
/// against a scratch `UserDefaults` rather than only through the interface.
@MainActor
public final class AppearanceStore: ObservableObject {
    public static let storageKey = "exarch.appearance"

    private let defaults: UserDefaults

    @Published public private(set) var preference: AppearancePreference

    public init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        let stored = defaults.string(forKey: Self.storageKey)
        // An unreadable or unknown value falls back to following the device
        // rather than to a hardcoded scheme.
        self.preference = stored.flatMap(AppearancePreference.init(rawValue:)) ?? .system
    }

    public func set(_ preference: AppearancePreference) {
        self.preference = preference
        defaults.set(preference.rawValue, forKey: Self.storageKey)
    }

    public func advance() {
        set(preference.next)
    }
}

/// The appearance control, sized to the 44pt minimum and labelled for VoiceOver.
public struct AppearanceButton: View {
    @ObservedObject private var store: AppearanceStore

    public init(store: AppearanceStore) {
        self.store = store
    }

    public var body: some View {
        Button {
            store.advance()
        } label: {
            Image(systemName: store.preference.symbolName)
                .font(.system(size: 15, weight: .medium))
                .foregroundStyle(FocusFlowTheme.accent)
                .frame(width: 30, height: 30)
                .background(FocusFlowTheme.surface, in: Circle())
                .overlay(Circle().stroke(FocusFlowTheme.border))
                .frame(width: 44, height: 44)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(store.preference.accessibilityLabel)
        .accessibilityHint(store.preference.accessibilityHint)
    }
}
