import Testing
#if canImport(UIKit)
import UIKit
#elseif canImport(AppKit)
import AppKit
#endif
@testable import ExarchUI

@Suite("Brand mark")
struct BrandMarkTests {
    /// Cinzel declares no SemiBold instance, and a weighted descriptor applied
    /// to the Regular face silently resolves back to Regular. An earlier
    /// revision asked for `Cinzel-SemiBold`, which resolves to nil — the
    /// wordmark rendered in the fallback serif and nothing reported it. This
    /// test fails instead.
    @Test("the bundled wordmark face registers and resolves")
    func wordmarkResolves() {
        #expect(BrandFont.wordmarkIsBundled)

        #if canImport(UIKit)
        let resolved = UIFont(name: BrandFont.wordmarkPostScriptName, size: 30)
        #elseif canImport(AppKit)
        let resolved = NSFont(name: BrandFont.wordmarkPostScriptName, size: 30)
        #endif
        #expect(resolved != nil)
        #expect(resolved?.familyName == "Cinzel")
    }

    @Test("the wordmark resource ships with the module")
    func resourceIsPresent() throws {
        let url = Bundle.module.url(forResource: "Cinzel-Variable", withExtension: "ttf")
        #expect(url != nil)
        // The SIL Open Font License requires the licence to travel with the font.
        #expect(Bundle.module.url(forResource: "OFL", withExtension: "txt") != nil)
    }
}
