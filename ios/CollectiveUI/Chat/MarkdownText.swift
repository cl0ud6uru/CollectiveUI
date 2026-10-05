import SwiftUI
import UIKit
import CollectiveKit

enum InlineMarkdown {
    /// Inline Markdown (bold, italic, code, links) with whitespace preserved; plain text on failure.
    static func attributed(_ text: String) -> AttributedString {
        let options = AttributedString.MarkdownParsingOptions(interpretedSyntax: .inlineOnlyPreservingWhitespace)
        if let parsed = try? AttributedString(markdown: text, options: options) {
            return parsed
        }
        return AttributedString(text)
    }
}

/// Lightweight block Markdown renderer for assistant replies.
@MainActor
struct MarkdownText: View {
    let text: String

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            ForEach(Array(MarkdownParser.blocks(from: text).enumerated()), id: \.offset) { item in
                MarkdownBlockView(block: item.element)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .textSelection(.enabled)
    }
}

@MainActor
struct MarkdownBlockView: View {
    let block: MarkdownBlock

    var body: some View {
        switch block {
        case .heading(let level, let text):
            Text(InlineMarkdown.attributed(text))
                .font(MarkdownBlockView.headingFont(level))
                .padding(.top, 4)
        case .paragraph(let text):
            Text(InlineMarkdown.attributed(text))
                .fixedSize(horizontal: false, vertical: true)
        case .code(let language, let code):
            CodeBlockView(language: language, code: code)
        case .listItem(_, let marker, let text, let indent):
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                Text(marker)
                    .monospacedDigit()
                    .foregroundStyle(.secondary)
                Text(InlineMarkdown.attributed(text))
                    .fixedSize(horizontal: false, vertical: true)
            }
            .padding(.leading, CGFloat(min(indent, 6)) * 16)
        case .quote(let text):
            HStack(alignment: .top, spacing: 10) {
                RoundedRectangle(cornerRadius: 1.5)
                    .fill(Color.secondary.opacity(0.5))
                    .frame(width: 3)
                Text(InlineMarkdown.attributed(text))
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        case .table(let table):
            ScrollView(.horizontal, showsIndicators: false) {
                Text(table)
                    .font(.system(.footnote, design: .monospaced))
                    .padding(10)
            }
            .background(
                RoundedRectangle(cornerRadius: 10, style: .continuous)
                    .fill(Color(uiColor: .secondarySystemBackground))
            )
        case .rule:
            Divider()
                .padding(.vertical, 4)
        }
    }

    static func headingFont(_ level: Int) -> Font {
        switch level {
        case 1:
            return Font.title2.bold()
        case 2:
            return Font.title3.bold()
        default:
            return Font.headline
        }
    }
}

@MainActor
struct CodeBlockView: View {
    let language: String?
    let code: String
    @State private var copied: Bool = false

    private var languageLabel: String {
        if let language, !language.isEmpty {
            return language
        }
        return "code"
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                Text(languageLabel)
                    .font(.caption.weight(.medium))
                    .foregroundStyle(.secondary)
                Spacer()
                Button {
                    UIPasteboard.general.string = code
                    copied = true
                } label: {
                    Label(copied ? "Copied" : "Copy", systemImage: copied ? "checkmark" : "doc.on.doc")
                        .font(.caption)
                }
                .buttonStyle(.borderless)
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 6)

            Divider()

            ScrollView(.horizontal, showsIndicators: true) {
                Text(code)
                    .font(.system(.footnote, design: .monospaced))
                    .textSelection(.enabled)
                    .fixedSize(horizontal: true, vertical: true)
                    .padding(12)
            }
        }
        .background(
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .fill(Color(uiColor: .secondarySystemBackground))
        )
        .overlay(
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .stroke(Color(uiColor: .separator), lineWidth: 0.5)
        )
        .task(id: copied) {
            await resetCopied()
        }
    }

    private func resetCopied() async {
        guard copied else { return }
        try? await Task.sleep(nanoseconds: 1_500_000_000)
        if !Task.isCancelled {
            copied = false
        }
    }
}
