#if canImport(AppKit)
import AppKit
import SwiftUI
import Testing
@testable import ExarchUI

/// Checks the palette against WCAG 2.1 in both appearances.
///
/// The review that prompted the light scheme also asked for contrast to be
/// verified rather than asserted, and two of the failures it found — white on
/// brass, and a completed-step checkmark on brass — were exactly the kind a
/// person only notices by looking. These ratios are computed from the tokens
/// themselves, so changing a hex value moves the test.
@Suite("Palette contrast")
struct ContrastTests {
    /// Resolves an adaptive token as it renders in one appearance.
    private func resolve(_ color: Color, dark: Bool) -> (r: Double, g: Double, b: Double) {
        let appearance = NSAppearance(named: dark ? .darkAqua : .aqua)!
        var components = (r: 0.0, g: 0.0, b: 0.0)
        appearance.performAsCurrentDrawingAppearance {
            let resolved = NSColor(color).usingColorSpace(.sRGB) ?? .black
            components = (Double(resolved.redComponent),
                          Double(resolved.greenComponent),
                          Double(resolved.blueComponent))
        }
        return components
    }

    private func luminance(_ c: (r: Double, g: Double, b: Double)) -> Double {
        func channel(_ v: Double) -> Double {
            v <= 0.03928 ? v / 12.92 : pow((v + 0.055) / 1.055, 2.4)
        }
        return 0.2126 * channel(c.r) + 0.7152 * channel(c.g) + 0.0722 * channel(c.b)
    }

    private func ratio(_ a: Color, on b: Color, dark: Bool) -> Double {
        let first = luminance(resolve(a, dark: dark))
        let second = luminance(resolve(b, dark: dark))
        let lighter = max(first, second), darker = min(first, second)
        return (lighter + 0.05) / (darker + 0.05)
    }

    @Test("body and secondary text clear AA in both appearances")
    func textContrast() {
        for dark in [false, true] {
            let scheme = dark ? "dark" : "light"
            #expect(ratio(FocusFlowTheme.ink, on: FocusFlowTheme.canvas, dark: dark) >= 4.5,
                    "ink on canvas, \(scheme)")
            #expect(ratio(FocusFlowTheme.ink, on: FocusFlowTheme.surface, dark: dark) >= 4.5,
                    "ink on surface, \(scheme)")
            #expect(ratio(FocusFlowTheme.secondaryInk, on: FocusFlowTheme.canvas, dark: dark) >= 4.5,
                    "secondaryInk on canvas, \(scheme)")
        }
    }

    /// The regression this suite exists for. White on the dark scheme's brass is
    /// about 2:1; `onAccent` inverts with the scheme so both directions pass.
    @Test("anything drawn on a saturated fill clears AA")
    func onFillContrast() {
        for dark in [false, true] {
            let scheme = dark ? "dark" : "light"
            #expect(ratio(FocusFlowTheme.onAccent, on: FocusFlowTheme.accent, dark: dark) >= 4.5,
                    "onAccent on accent, \(scheme)")
            #expect(ratio(FocusFlowTheme.onAccent, on: FocusFlowTheme.success, dark: dark) >= 4.5,
                    "onAccent on success, \(scheme)")
            #expect(ratio(.white, on: FocusFlowTheme.accent, dark: true) < 4.5,
                    "white on brass should still be the failure it was")
        }
    }

    /// `raised` took over the status pill from `accentSoft`, so it now carries
    /// text and has to clear the same floor the fill it replaced did.
    @Test("secondary text clears AA on the fills that carry it")
    func fillTextContrast() {
        for dark in [false, true] {
            let scheme = dark ? "dark" : "light"
            #expect(ratio(FocusFlowTheme.secondaryInk, on: FocusFlowTheme.raised, dark: dark) >= 4.5,
                    "secondaryInk on raised, \(scheme)")
            #expect(ratio(FocusFlowTheme.ink, on: FocusFlowTheme.accentSoft, dark: dark) >= 4.5,
                    "ink on accentSoft, \(scheme)")
        }
    }

    @Test("accent and status colours clear the 3:1 floor for controls and glyphs")
    func nonTextContrast() {
        for dark in [false, true] {
            let scheme = dark ? "dark" : "light"
            for (name, colour) in [
                ("accent", FocusFlowTheme.accent),
                ("attention", FocusFlowTheme.attention),
                ("danger", FocusFlowTheme.danger),
                ("success", FocusFlowTheme.success)
            ] {
                #expect(ratio(colour, on: FocusFlowTheme.canvas, dark: dark) >= 3.0,
                        "\(name) on canvas, \(scheme)")
                #expect(ratio(colour, on: FocusFlowTheme.surface, dark: dark) >= 3.0,
                        "\(name) on surface, \(scheme)")
            }
        }
    }

    @Test("the terminal keeps its own foreground because it ignores the scheme")
    func terminalContrast() {
        for dark in [false, true] {
            #expect(ratio(FocusFlowTheme.terminalInk, on: FocusFlowTheme.terminal, dark: dark) >= 4.5)
        }
    }
}
#endif
