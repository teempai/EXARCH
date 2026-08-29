#!/usr/bin/env swift

// Renders the EXARCH app icons from the bundled Cinzel face.
//
// The icons are committed, but they are generated rather than drawn by hand so
// the mark stays reproducible: change a value here, rerun, and both asset
// catalogs are rewritten identically. Run from the repository root:
//
//     swift scripts/generate-app-icons.swift
//
// The specification these values implement is docs/design/STYLE_GUIDE.md §4.3.

import AppKit
import CoreText
import Foundation

// MARK: - Specification

/// docs/design/STYLE_GUIDE.md §3.1
let accent = NSColor(srgbRed: 0.780, green: 0.643, blue: 0.427, alpha: 1)   // #C7A46D
let raised = NSColor(srgbRed: 0.114, green: 0.129, blue: 0.165, alpha: 1)   // #1D212A
let canvas = NSColor(srgbRed: 0.043, green: 0.051, blue: 0.067, alpha: 1)   // #0B0D11
let hairline = NSColor(white: 1, alpha: 0.10)

/// Cap height of the E as a fraction of the tile it sits in, at display sizes.
let capHeightRatio: CGFloat = 0.46
/// macOS draws its own rounded square; iOS is full bleed and masked by the system.
let macBodyRatio: CGFloat = 824.0 / 1024.0
let macCornerRatio: CGFloat = 185.4 / 824.0

/// Optical sizing for the small end of the macOS ladder.
///
/// A letterform scaled linearly to 16px is a brass blob: the counter closes and
/// the serifs fall below a pixel. Below 64px the letter grows into the tile and
/// the surrounding margin shrinks, which is the same thing an icon designer
/// does by hand when drawing the small members of a set.
func opticalCapHeight(forPixels pixels: Int) -> CGFloat {
    switch pixels {
    case ..<24: 0.68
    case ..<48: 0.60
    case ..<96: 0.52
    default: capHeightRatio
    }
}

func opticalBodyRatio(forPixels pixels: Int) -> CGFloat {
    switch pixels {
    case ..<24: 0.94
    case ..<48: 0.90
    case ..<96: 0.86
    default: macBodyRatio
    }
}

let root = URL(fileURLWithPath: FileManager.default.currentDirectoryPath)
let fontURL = root.appendingPathComponent("native/Sources/ExarchUI/Resources/Cinzel-Variable.ttf")

// MARK: - Font

var registrationError: Unmanaged<CFError>?
guard CTFontManagerRegisterFontsForURL(fontURL as CFURL, .process, &registrationError) else {
    FileHandle.standardError.write(Data("Could not register \(fontURL.path)\n".utf8))
    exit(1)
}
let faceName = "CinzelRoman-Bold" as CFString
guard NSFont(name: faceName as String, size: 12) != nil else {
    FileHandle.standardError.write(Data("\(faceName) did not resolve after registration\n".utf8))
    exit(1)
}

/// The ink bounds of a glyph at a given size, which is what optical centring
/// needs — the typographic line box carries ascent and descent the letter E
/// does not use, and centring on it leaves the mark sitting low.
func inkBounds(_ character: String, size: CGFloat) -> (font: CTFont, glyph: CGGlyph, rect: CGRect) {
    let font = CTFontCreateWithName(faceName, size, nil)
    var glyph = CGGlyph()
    var chars = Array(character.utf16)
    guard CTFontGetGlyphsForCharacters(font, &chars, &glyph, 1) else {
        FileHandle.standardError.write(Data("No glyph for \(character)\n".utf8))
        exit(1)
    }
    var rect = CGRect.zero
    var mutableGlyph = glyph
    withUnsafeMutablePointer(to: &mutableGlyph) { glyphPointer in
        withUnsafeMutablePointer(to: &rect) { rectPointer in
            _ = CTFontGetBoundingRectsForGlyphs(font, .horizontal, glyphPointer, rectPointer, 1)
        }
    }
    return (font, glyph, rect)
}

// MARK: - Drawing

enum Style {
    /// Brass letter on the gradient. The default icon on both platforms.
    case full
    /// Letter only on transparency, for the iOS dark appearance where the
    /// system supplies its own backdrop.
    case foregroundOnly(NSColor)
}

func render(pixels: Int, rounded: Bool, style: Style) -> Data {
    let side = CGFloat(pixels)
    guard let rep = NSBitmapImageRep(
        bitmapDataPlanes: nil,
        pixelsWide: pixels, pixelsHigh: pixels,
        bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
        colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0
    ) else { exit(1) }
    rep.size = NSSize(width: side, height: side)

    NSGraphicsContext.saveGraphicsState()
    guard let context = NSGraphicsContext(bitmapImageRep: rep) else { exit(1) }
    NSGraphicsContext.current = context
    let cg = context.cgContext
    cg.clear(CGRect(x: 0, y: 0, width: side, height: side))

    // The square the mark is composed inside: the whole tile on iOS, the
    // rounded body on macOS.
    var body = CGRect(x: 0, y: 0, width: side, height: side)
    if rounded {
        let inset = side * (1 - opticalBodyRatio(forPixels: pixels)) / 2
        body = body.insetBy(dx: inset, dy: inset)
    }

    if case .full = style {
        cg.saveGState()
        if rounded {
            let path = CGPath(
                roundedRect: body,
                cornerWidth: body.width * macCornerRatio,
                cornerHeight: body.width * macCornerRatio,
                transform: nil
            )
            cg.addPath(path)
            cg.clip()
        }
        let gradient = CGGradient(
            colorsSpace: CGColorSpaceCreateDeviceRGB(),
            colors: [raised.cgColor, canvas.cgColor] as CFArray,
            locations: [0, 1]
        )!
        // Lighter at the top, per §4.3.
        cg.drawLinearGradient(
            gradient,
            start: CGPoint(x: body.midX, y: body.maxY),
            end: CGPoint(x: body.midX, y: body.minY),
            options: []
        )
        cg.restoreGState()

        if rounded, side >= 64 {
            let path = NSBezierPath(
                roundedRect: body.insetBy(dx: 0.5, dy: 0.5),
                xRadius: body.width * macCornerRatio,
                yRadius: body.width * macCornerRatio
            )
            hairline.setStroke()
            path.lineWidth = max(1, side / 512)
            path.stroke()
        }
    }

    // Size the letter so its ink height is the specified fraction of the body,
    // then place its ink box dead centre.
    let target = body.height * opticalCapHeight(forPixels: pixels)
    let probe = inkBounds("E", size: 100)
    let size = 100 * target / probe.rect.height
    let (font, glyph, rect) = inkBounds("E", size: size)

    let colour: NSColor
    switch style {
    case .full: colour = accent
    case let .foregroundOnly(c): colour = c
    }
    cg.setFillColor(colour.cgColor)

    var position = CGPoint(
        x: body.midX - rect.midX,
        y: body.midY - rect.midY
    )
    var mutableGlyph = glyph
    withUnsafePointer(to: &mutableGlyph) { glyphPointer in
        withUnsafePointer(to: &position) { positionPointer in
            CTFontDrawGlyphs(font, glyphPointer, positionPointer, 1, cg)
        }
    }

    NSGraphicsContext.restoreGraphicsState()
    guard let data = rep.representation(using: .png, properties: [:]) else { exit(1) }
    return data
}

// MARK: - Emit

func write(_ data: Data, to url: URL) {
    try? FileManager.default.createDirectory(
        at: url.deletingLastPathComponent(), withIntermediateDirectories: true
    )
    try! data.write(to: url)
    print("  \(url.lastPathComponent)  \(data.count) bytes")
}

// iOS: one 1024 tile per appearance. The system masks the corners and, for the
// dark and tinted appearances, supplies the backdrop.
let iosSet = root.appendingPathComponent("native/Apps/iOS/Assets.xcassets/AppIcon.appiconset")
print("iOS")
write(render(pixels: 1024, rounded: false, style: .full), to: iosSet.appendingPathComponent("icon-1024.png"))
write(render(pixels: 1024, rounded: false, style: .foregroundOnly(accent)),
      to: iosSet.appendingPathComponent("icon-1024-dark.png"))
write(render(pixels: 1024, rounded: false, style: .foregroundOnly(NSColor(white: 0.88, alpha: 1))),
      to: iosSet.appendingPathComponent("icon-1024-tinted.png"))

let iosContents = """
{
  "images" : [
    {
      "filename" : "icon-1024.png",
      "idiom" : "universal",
      "platform" : "ios",
      "size" : "1024x1024"
    },
    {
      "appearances" : [
        {
          "appearance" : "luminosity",
          "value" : "dark"
        }
      ],
      "filename" : "icon-1024-dark.png",
      "idiom" : "universal",
      "platform" : "ios",
      "size" : "1024x1024"
    },
    {
      "appearances" : [
        {
          "appearance" : "luminosity",
          "value" : "tinted"
        }
      ],
      "filename" : "icon-1024-tinted.png",
      "idiom" : "universal",
      "platform" : "ios",
      "size" : "1024x1024"
    }
  ],
  "info" : {
    "author" : "xcode",
    "version" : 1
  }
}

"""
write(Data(iosContents.utf8), to: iosSet.appendingPathComponent("Contents.json"))

// macOS: the full ladder, and the artwork draws its own rounded square because
// the system does not mask Mac icons.
let macSet = root.appendingPathComponent("native/Apps/macOS/Assets.xcassets/AppIcon.appiconset")
let macSizes: [(point: Int, scale: Int)] = [
    (16, 1), (16, 2), (32, 1), (32, 2), (128, 1), (128, 2), (256, 1), (256, 2), (512, 1), (512, 2)
]
print("macOS")
var macImages: [String] = []
for entry in macSizes {
    let pixels = entry.point * entry.scale
    let name = "icon-\(entry.point)x\(entry.point)@\(entry.scale)x.png"
    write(render(pixels: pixels, rounded: true, style: .full), to: macSet.appendingPathComponent(name))
    macImages.append("""
        {
          "filename" : "\(name)",
          "idiom" : "mac",
          "scale" : "\(entry.scale)x",
          "size" : "\(entry.point)x\(entry.point)"
        }
    """.trimmingCharacters(in: .whitespaces))
}
let macContents = """
{
  "images" : [
    \(macImages.joined(separator: ",\n    "))
  ],
  "info" : {
    "author" : "xcode",
    "version" : 1
  }
}

"""
write(Data(macContents.utf8), to: macSet.appendingPathComponent("Contents.json"))
print("done")
