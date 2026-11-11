// Draws the 1024px app icon: black tile, white arrow, green baseline.
// Usage: swift icon.swift out.png
import Cocoa

let size: CGFloat = 1024
let img = NSImage(size: NSSize(width: size, height: size))
img.lockFocus()
let ctx = NSGraphicsContext.current!.cgContext

// macOS icon grid: 824pt tile centred in 1024.
let tile = CGRect(x: 100, y: 100, width: 824, height: 824)
ctx.addPath(CGPath(roundedRect: tile, cornerWidth: 186, cornerHeight: 186, transform: nil))
ctx.setFillColor(NSColor.black.cgColor)
ctx.fillPath()

// Arrow (y grows upward in AppKit).
let white = NSColor.white.cgColor
ctx.setFillColor(white)
let stem: CGFloat = 92, cx = size / 2
ctx.fill(CGRect(x: cx - stem / 2, y: 452, width: stem, height: 300))
ctx.move(to: CGPoint(x: cx - 196, y: 500))
ctx.addLine(to: CGPoint(x: cx + 196, y: 500))
ctx.addLine(to: CGPoint(x: cx, y: 304))
ctx.closePath()
ctx.fillPath()

// Green baseline.
ctx.setFillColor(NSColor(srgbRed: 0, green: 0xB1 / 255.0, blue: 0x40 / 255.0, alpha: 1).cgColor)
ctx.fill(CGRect(x: cx - 196, y: 214, width: 392, height: 52))

img.unlockFocus()
let rep = NSBitmapImageRep(data: img.tiffRepresentation!)!
try! rep.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: CommandLine.arguments[1]))
