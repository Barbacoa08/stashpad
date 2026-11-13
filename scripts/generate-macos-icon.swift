#!/usr/bin/env swift
// Run from the repository root on macOS: swift scripts/generate-macos-icon.swift
// Each Retina image uses its logical size's artwork, not its pixel size's artwork.
import AppKit
import CryptoKit
import Foundation
import ImageIO

let sources: [(String, String)] = [
    ("large-fuller-rounded-contour.png", "41c85be38d572bc9d23dc6d42f21f964d5eb2fe25629c3e654cfe203af2a0750"),
    ("compact-128.png", "8f69b44322d7f9ff727aa02e13fc9a187c8133c7f10bff0e09bab85cd3ef63cc"),
    ("d2-64.png", "5ec6a44b03dfb9e7e32b735adc639d33405cf3bf0de9d2fd342175b70b7a5893"),
    ("ribbon-plus-3-32.png", "b8c4d2623b21580304926e2ae81fb741edff142864c5108605c0817bedc5c7e0"),
    ("tree-only-small.png", "08ff1e5f3bf8947ec43a89cf69ebc68bd8ac1fe56f3c18576d9ed700c0c902ba"),
]
let base = URL(fileURLWithPath: FileManager.default.currentDirectoryPath)
let artwork = base.appendingPathComponent("docs/branding/reference-artwork")
for (name, expected) in sources {
    let data = try Data(contentsOf: artwork.appendingPathComponent(name))
    let hash = SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    precondition(hash == expected, "Unexpected source hash: \(name)")
}
let temporaryDirectory = FileManager.default.temporaryDirectory
    .appendingPathComponent("stashpad-icon-" + UUID().uuidString, isDirectory: true)
try FileManager.default.createDirectory(at: temporaryDirectory, withIntermediateDirectories: false)
do {
    defer { try? FileManager.default.removeItem(at: temporaryDirectory) }
    let iconset = temporaryDirectory.appendingPathComponent("Generated.iconset", isDirectory: true)
    try FileManager.default.createDirectory(at: iconset, withIntermediateDirectories: false)
    for logical in [16, 32, 128, 256, 512] {
        for scale in [1, 2] {
            let size = logical * scale
            let source = logical == 16 ? sources[4].0 : logical == 32 ? sources[3].0 : logical == 128 ? sources[1].0 : sources[0].0
            guard let imageSource = CGImageSourceCreateWithURL(artwork.appendingPathComponent(source) as CFURL, nil),
                  let image = CGImageSourceCreateImageAtIndex(imageSource, 0, nil),
                  let context = CGContext(data: nil, width: size, height: size, bitsPerComponent: 8,
                                          bytesPerRow: 0, space: CGColorSpaceCreateDeviceRGB(),
                                          bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { fatalError("Image creation failed") }
            let side = CGFloat(size)
            context.interpolationQuality = .high
            // The reference background is near-white. Sampling its corner keeps the
            // tile and artwork continuous without changing the approved mark.
            guard let sample = CGContext(data: nil, width: 1, height: 1, bitsPerComponent: 8, bytesPerRow: 4,
                                         space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue),
                  let corner = image.cropping(to: CGRect(x: 0, y: 0, width: 1, height: 1)) else { fatalError("Sampling failed") }
            sample.draw(corner, in: CGRect(x: 0, y: 0, width: 1, height: 1))
            let pixel = sample.data!.assumingMemoryBound(to: UInt8.self)
            context.setFillColor(red: CGFloat(pixel[0]) / 255, green: CGFloat(pixel[1]) / 255, blue: CGFloat(pixel[2]) / 255, alpha: 1)
            let tile = CGRect(x: side * 0.1, y: side * 0.1, width: side * 0.8, height: side * 0.8)
            context.addPath(CGPath(roundedRect: tile, cornerWidth: side * 0.18, cornerHeight: side * 0.18, transform: nil))
            context.fillPath()
            context.draw(image, in: CGRect(x: side * 0.18, y: side * 0.18, width: side * 0.64, height: side * 0.64))
            guard let result = context.makeImage() else { fatalError("Rendering failed") }
            let suffix = scale == 2 ? "@2x" : ""
            let output = iconset.appendingPathComponent("icon_\(logical)x\(logical)\(suffix).png")
            guard let destination = CGImageDestinationCreateWithURL(output as CFURL, "public.png" as CFString, 1, nil) else { fatalError("PNG creation failed") }
            CGImageDestinationAddImage(destination, result, nil)
            guard CGImageDestinationFinalize(destination) else { fatalError("PNG write failed") }
        }
    }
    // ICNS stores each PNG in a named representation chunk. Writing the container
    // directly avoids conflating equally sized 1x and 2x artwork.
    let slots = [("icp4", "icon_16x16.png"), ("ic11", "icon_16x16@2x.png"),
                 ("icp5", "icon_32x32.png"), ("ic12", "icon_32x32@2x.png"),
                 ("ic07", "icon_128x128.png"), ("ic13", "icon_128x128@2x.png"),
                 ("ic08", "icon_256x256.png"), ("ic14", "icon_256x256@2x.png"),
                 ("ic09", "icon_512x512.png"), ("ic10", "icon_512x512@2x.png")]
    func bigEndian(_ value: Int) -> Data {
        var number = UInt32(value).bigEndian
        return Data(bytes: &number, count: 4)
    }
    var chunks = Data()
    for (type, filename) in slots {
        let png = try Data(contentsOf: iconset.appendingPathComponent(filename))
        chunks.append(contentsOf: type.utf8)
        chunks.append(bigEndian(png.count + 8))
        chunks.append(png)
    }
    var container = Data("icns".utf8)
    container.append(bigEndian(chunks.count + 8))
    container.append(chunks)
    try container.write(to: base.appendingPathComponent("src-tauri/icons/icon.icns"), options: .atomic)
}
