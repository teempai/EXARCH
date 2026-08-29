import SwiftUI
#if canImport(UIKit)
import UIKit
#elseif canImport(AppKit)
import AppKit
#endif

/// The EXARCH palette, in both appearances.
///
/// Every token resolves against the surrounding colour scheme, so a view never
/// asks which appearance it is in. The scheme itself comes from
/// `AppearancePreference`, which the user controls and which is persisted.
///
/// Brass changes value between the two schemes rather than staying fixed: the
/// light brass that carries a dark ground is about 1.9:1 on white and unusable,
/// so the light scheme uses a darkened brass instead. Anything drawn *on* brass
/// therefore has to use `onAccent` rather than a literal, because the readable
/// colour flips between schemes.
///
/// Values and rules are documented in `docs/design/STYLE_GUIDE.md` §3.
public enum FocusFlowTheme {
    /// #F3F3F5 light · #0B0D11 dark — the ground everything sits on.
    public static let canvas = adaptive(light: 0xF3F3F5, dark: 0x0B0D11)
    /// #FFFFFF light · #15181F dark — cards, bars, the composer, circular controls.
    public static let surface = adaptive(light: 0xFFFFFF, dark: 0x15181F)
    /// #E8E9EC light · #1D212A dark — a step from `surface`: inline code, segmented tracks.
    public static let raised = adaptive(light: 0xE8E9EC, dark: 0x1D212A)
    /// #14171C light · #ECE8E0 dark — primary text.
    public static let ink = adaptive(light: 0x14171C, dark: 0xECE8E0)
    /// #5B6069 light · #8E949E dark — captions, metadata, disabled text.
    public static let secondaryInk = adaptive(light: 0x5B6069, dark: 0x8E949E)
    /// #8A6832 light · #C7A46D dark — brass. Identity and action only, never status.
    public static let accent = adaptive(light: 0x8A6832, dark: 0xC7A46D)
    /// Text and glyphs drawn on top of `accent`.
    ///
    /// Light brass needs a dark mark and dark brass needs a light one, so this
    /// is not `canvas` or `ink` — it inverts relative to them. Roughly 5.2:1 in
    /// the light scheme and 9.6:1 in the dark one.
    public static let onAccent = adaptive(light: 0xFFFFFF, dark: 0x0B0D11)
    /// #F2E9D9 light · #2A2113 dark — the accent at rest: user bubbles, selected chips.
    public static let accentSoft = adaptive(light: 0xF2E9D9, dark: 0x2A2113)
    /// #9A5410 light · #E08A3C dark — warnings, such as applied redaction.
    public static let attention = adaptive(light: 0x9A5410, dark: 0xE08A3C)
    /// #A8291C light · #E5867A dark — destructive and failed states.
    public static let danger = adaptive(light: 0xA8291C, dark: 0xE5867A)
    /// #1B6347 light · #74C4A8 dark — healthy providers, verified chains, completed stages.
    public static let success = adaptive(light: 0x1B6347, dark: 0x74C4A8)
    public static let border = adaptive(lightWhite: 0, lightAlpha: 0.12, darkWhite: 1, darkAlpha: 0.10)

    /// #07090C in both schemes.
    ///
    /// The Mac live-activity pane is a terminal, and a terminal is dark in a
    /// light application too. It is the one deliberately appearance-independent
    /// surface, so it carries its own foreground token rather than `ink`.
    public static let terminal = Color(red: 0.027, green: 0.035, blue: 0.047)
    /// Text on `terminal`, which does not follow the scheme either.
    public static let terminalInk = Color.white.opacity(0.78)

    // MARK: - Resolution

    private static func adaptive(light: UInt32, dark: UInt32) -> Color {
        #if canImport(UIKit)
        return Color(UIColor { traits in
            traits.userInterfaceStyle == .dark ? UIColor(rgb: dark) : UIColor(rgb: light)
        })
        #elseif canImport(AppKit)
        return Color(NSColor(name: nil) { appearance in
            appearance.isDarkAppearance ? NSColor(rgb: dark) : NSColor(rgb: light)
        })
        #else
        return Color(rgb: dark)
        #endif
    }

    private static func adaptive(
        lightWhite: Double, lightAlpha: Double, darkWhite: Double, darkAlpha: Double
    ) -> Color {
        #if canImport(UIKit)
        return Color(UIColor { traits in
            traits.userInterfaceStyle == .dark
                ? UIColor(white: darkWhite, alpha: darkAlpha)
                : UIColor(white: lightWhite, alpha: lightAlpha)
        })
        #elseif canImport(AppKit)
        return Color(NSColor(name: nil) { appearance in
            appearance.isDarkAppearance
                ? NSColor(white: darkWhite, alpha: darkAlpha)
                : NSColor(white: lightWhite, alpha: lightAlpha)
        })
        #else
        return Color(white: darkWhite).opacity(darkAlpha)
        #endif
    }
}

#if canImport(UIKit)
private extension UIColor {
    convenience init(rgb: UInt32) {
        self.init(
            red: CGFloat((rgb >> 16) & 0xFF) / 255,
            green: CGFloat((rgb >> 8) & 0xFF) / 255,
            blue: CGFloat(rgb & 0xFF) / 255,
            alpha: 1
        )
    }
}
#elseif canImport(AppKit)
private extension NSColor {
    convenience init(rgb: UInt32) {
        self.init(
            srgbRed: CGFloat((rgb >> 16) & 0xFF) / 255,
            green: CGFloat((rgb >> 8) & 0xFF) / 255,
            blue: CGFloat(rgb & 0xFF) / 255,
            alpha: 1
        )
    }
}

private extension NSAppearance {
    var isDarkAppearance: Bool {
        bestMatch(from: [.aqua, .darkAqua]) == .darkAqua
    }
}
#endif

public struct StatusPill: View {
    let label: String
    let active: Bool

    public init(_ label: String, active: Bool = true) {
        self.label = label
        self.active = active
    }

    public var body: some View {
        HStack(spacing: 6) {
            Circle()
                .fill(active ? FocusFlowTheme.success : FocusFlowTheme.secondaryInk.opacity(0.5))
                .frame(width: 7, height: 7)
            Text(label)
                .font(.caption.weight(.medium))
                .foregroundStyle(FocusFlowTheme.secondaryInk)
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 6)
        .background(FocusFlowTheme.surface, in: Capsule())
        .overlay(Capsule().stroke(FocusFlowTheme.border))
    }
}

/// A filled brass button whose label is guaranteed to be readable on it.
///
/// `.borderedProminent` under a brass tint picks its own label colour, which is
/// white — about 2:1 on the dark scheme's light brass, failing WCAG AA. This
/// style takes `onAccent` instead, which inverts with the scheme.
public struct ProminentBrassButtonStyle: ButtonStyle {
    @Environment(\.isEnabled) private var isEnabled

    public init() {}

    public func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.body.weight(.semibold))
            .foregroundStyle(FocusFlowTheme.onAccent)
            .padding(.horizontal, 18)
            .padding(.vertical, 12)
            .frame(minHeight: 44)
            .background(
                FocusFlowTheme.accent.opacity(isEnabled ? (configuration.isPressed ? 0.8 : 1) : 0.4),
                in: RoundedRectangle(cornerRadius: 11, style: .continuous)
            )
            .contentShape(RoundedRectangle(cornerRadius: 11, style: .continuous))
    }
}

public extension ButtonStyle where Self == ProminentBrassButtonStyle {
    /// Use instead of `.borderedProminent` wherever the fill is brass.
    static var prominentBrass: ProminentBrassButtonStyle { ProminentBrassButtonStyle() }
}
