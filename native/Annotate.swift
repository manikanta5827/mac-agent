import AppKit
import UniformTypeIdentifiers

let boxColors: [NSColor] = [.systemRed, .systemBlue, .systemGreen, .systemOrange, .systemPurple, .systemPink]

func annotate(input: String, outputPath: String, boxes: [Box]) {
    guard let source = CGImageSourceCreateWithURL(URL(fileURLWithPath: input) as CFURL, nil),
          let image = CGImageSourceCreateImageAtIndex(source, 0, nil) else { fail("Cannot read image \(input)") }
    let width = image.width, height = image.height
    guard let ctx = CGContext(data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0,
                              space: CGColorSpaceCreateDeviceRGB(),
                              bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { fail("Cannot create drawing context") }
    ctx.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))

    ctx.translateBy(x: 0, y: CGFloat(height))
    ctx.scaleBy(x: 1, y: -1)
    NSGraphicsContext.current = NSGraphicsContext(cgContext: ctx, flipped: true)

    let font = NSFont.boldSystemFont(ofSize: 11)
    for (i, box) in boxes.enumerated() {
        let color = boxColors[i % boxColors.count]
        let rect = CGRect(x: box.x, y: box.y, width: box.w, height: box.h)
        ctx.setStrokeColor(color.cgColor)
        ctx.setLineWidth(2)
        ctx.stroke(rect)

        let text = box.label as NSString
        let attributes: [NSAttributedString.Key: Any] = [.font: font, .foregroundColor: NSColor.white]
        let size = text.size(withAttributes: attributes)
        let tag = CGSize(width: size.width + 4, height: size.height)
        let tagY = box.y - tag.height >= 0 ? box.y - tag.height : box.y
        let tagRect = CGRect(x: box.x, y: tagY, width: tag.width, height: tag.height)
        ctx.setFillColor(color.cgColor)
        ctx.fill(tagRect)
        text.draw(at: CGPoint(x: tagRect.minX + 2, y: tagRect.minY), withAttributes: attributes)
    }
    NSGraphicsContext.current = nil

    guard let result = ctx.makeImage(),
          let destination = CGImageDestinationCreateWithURL(URL(fileURLWithPath: outputPath) as CFURL,
                                                            UTType.jpeg.identifier as CFString, 1, nil) else {
        fail("Cannot write image \(outputPath)")
    }
    CGImageDestinationAddImage(destination, result, [kCGImageDestinationLossyCompressionQuality: 0.85] as CFDictionary)
    guard CGImageDestinationFinalize(destination) else { fail("Cannot write image \(outputPath)") }
}
