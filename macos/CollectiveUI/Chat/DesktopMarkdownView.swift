import SwiftUI
import CollectiveKit

@MainActor
struct DesktopMarkdownView: View {
    let text: String

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            ForEach(Array(MarkdownParser.blocks(from: text).enumerated()), id: \.offset) { item in
                block(item.element)
            }
        }
        .textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading)
    }

    @ViewBuilder
    private func block(_ value: MarkdownBlock) -> some View {
        switch value {
        case .heading(let level, let text): Text(inline(text)).font(level == 1 ? .title2 : .headline)
        case .paragraph(let text): Text(inline(text)).fixedSize(horizontal: false, vertical: true)
        case .code(let language, let code):
            VStack(alignment: .leading, spacing: 8) {
                HStack {
                    Text(language ?? "Code").font(.caption).foregroundStyle(.secondary)
                    Spacer()
                    Button("Copy Code", systemImage: "doc.on.doc") { DesktopClipboard.copy(code) }.buttonStyle(.borderless)
                }
                ScrollView(.horizontal) { Text(code).font(.system(.body, design: .monospaced)).fixedSize() }
            }.padding(12).background(.quaternary, in: RoundedRectangle(cornerRadius: 8))
        case .listItem(_, let marker, let text, let indent):
            HStack(alignment: .firstTextBaseline) { Text(marker); Text(inline(text)) }
                .padding(.leading, CGFloat(min(indent, 6)) * 16)
        case .quote(let text): Text(inline(text)).foregroundStyle(.secondary).padding(.leading, 12)
        case .table(let text): ScrollView(.horizontal) { Text(text).font(.system(.body, design: .monospaced)) }
        case .rule: Divider()
        }
    }

    private func inline(_ value: String) -> AttributedString {
        (try? AttributedString(markdown: value, options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace))) ?? AttributedString(value)
    }
}
