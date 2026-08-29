import CoreText
import SwiftUI
#if canImport(UIKit)
import UIKit
#elseif canImport(AppKit)
import AppKit
#endif

/// The EXARCH wordmark and the one typeface that is allowed to be decorative.
///
/// Everything else in both apps uses the system font, so it inherits Dynamic
/// Type, optical sizing, and localisation for free. Cinzel appears only where
/// `ExarchWordmark` is used. See `docs/design/STYLE_GUIDE.md`.
public enum BrandFont {
    /// PostScript name of the face the wordmark is set in.
    ///
    /// Cinzel ships as a single variable font whose `wght` axis runs 400–900,
    /// and it declares exactly three named instances: `Cinzel-Regular`,
    /// `CinzelRoman-Bold`, and `CinzelRoman-Black`. There is no SemiBold, and a
    /// weighted font descriptor applied to the Regular face silently resolves
    /// back to Regular rather than moving along the axis — so Bold is both the
    /// closest real master to the intended weight and the only way to get it.
    static let wordmarkPostScriptName = "CinzelRoman-Bold"

    /// Registers the bundled face with the process on first use.
    ///
    /// Registering from the module bundle rather than through `UIAppFonts` or
    /// `ATSApplicationFontsPath` means both apps, the test target, and SwiftUI
    /// previews all resolve the mark identically, and neither Info.plist has to
    /// know the font exists.
    private static let registration: Bool = {
        guard let url = Bundle.module.url(forResource: "Cinzel-Variable", withExtension: "ttf") else {
            return false
        }
        var error: Unmanaged<CFError>?
        if CTFontManagerRegisterFontsForURL(url as CFURL, .process, &error) {
            return true
        }
        // Already registered by another caller is a success for our purposes.
        guard let failure = error?.takeRetainedValue() else { return false }
        return CFErrorGetCode(failure) == CTFontManagerError.alreadyRegistered.rawValue
    }()

    /// True when the face actually resolves. Checked rather than assumed,
    /// because a font that registers but exposes a different PostScript name
    /// would otherwise fail silently and forever.
    public static var wordmarkIsBundled: Bool {
        guard registration else { return false }
        #if canImport(UIKit)
        return UIFont(name: wordmarkPostScriptName, size: 12) != nil
        #elseif canImport(AppKit)
        return NSFont(name: wordmarkPostScriptName, size: 12) != nil
        #else
        return false
        #endif
    }

    /// Cinzel where available, and a serif system face where it is not.
    ///
    /// The fallback keeps the wordmark Roman and inscriptional rather than
    /// dropping to the UI sans, so a build without the resource degrades to
    /// something close instead of something wrong.
    public static func wordmark(size: CGFloat, relativeTo style: Font.TextStyle) -> Font {
        guard wordmarkIsBundled else {
            return .system(size: size, weight: .semibold, design: .serif)
        }
        return .custom(wordmarkPostScriptName, size: size, relativeTo: style)
    }
}

/// The wordmark, set the only way it is allowed to be set.
///
/// Uppercase, tracked, and never below 11pt. The tracking is expressed as a
/// fraction of the size so it holds at every Dynamic Type setting.
public struct ExarchWordmark: View {
    private let size: CGFloat
    private let style: Font.TextStyle

    /// - Parameters:
    ///   - size: point size. The style guide floor is 11.
    ///   - relativeTo: the text style the mark scales with.
    public init(size: CGFloat = 15, relativeTo style: Font.TextStyle = .headline) {
        self.size = size
        self.style = style
    }

    public var body: some View {
        Text(verbatim: "EXARCH")
            .font(BrandFont.wordmark(size: size, relativeTo: style))
            .tracking(size * 0.20)
            // The tracking adds trailing space after the final letter, which
            // pushes an otherwise centred mark left of centre.
            .padding(.leading, size * 0.20)
            .foregroundStyle(FocusFlowTheme.accent)
            .accessibilityLabel("Exarch")
            .accessibilityAddTraits(.isHeader)
    }
}

/// A borderless icon inside a circular surface, used for navigation controls
/// that need to stay legible over scrolling conversation content.
public struct CircleIconButton: View {
    private let systemImage: String
    private let label: String
    private let diameter: CGFloat
    private let action: () -> Void

    public init(
        systemImage: String,
        label: String,
        diameter: CGFloat = 30,
        action: @escaping () -> Void
    ) {
        self.systemImage = systemImage
        self.label = label
        self.diameter = diameter
        self.action = action
    }

    public var body: some View {
        Button(action: action) {
            Image(systemName: systemImage)
                .font(.system(size: diameter * 0.44, weight: .semibold))
                .foregroundStyle(FocusFlowTheme.accent)
                .frame(width: diameter, height: diameter)
                .background(FocusFlowTheme.surface, in: Circle())
                .overlay(Circle().stroke(FocusFlowTheme.border))
                // The circle is 30pt so it sits inside a 44pt bar; the hit area
                // stays 44pt so it still meets the pointer and touch minimum.
                .frame(width: 44, height: 44)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(label)
    }
}
