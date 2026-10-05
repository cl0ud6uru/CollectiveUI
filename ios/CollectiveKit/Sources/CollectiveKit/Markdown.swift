import Foundation

/// Block-level Markdown structure. Inline formatting is left to the renderer.
public enum MarkdownBlock: Hashable, Sendable {
    case heading(level: Int, text: String)
    case paragraph(String)
    case code(language: String?, code: String)
    case listItem(ordered: Bool, marker: String, text: String, indent: Int)
    case quote(String)
    case table(String)
    case rule
}

/// A small, forgiving block parser covering what chat replies typically contain.
public enum MarkdownParser {
    public static func blocks(from source: String) -> [MarkdownBlock] {
        let normalized = source.replacingOccurrences(of: "\r\n", with: "\n")
        let lines = normalized.components(separatedBy: "\n")
        var blocks: [MarkdownBlock] = []
        var paragraph: [String] = []

        func flushParagraph() {
            if !paragraph.isEmpty {
                blocks.append(.paragraph(paragraph.joined(separator: "\n")))
                paragraph.removeAll()
            }
        }

        var index = 0
        while index < lines.count {
            let line = lines[index]
            let trimmed = line.trimmingCharacters(in: .whitespaces)

            // Fenced code block.
            if trimmed.hasPrefix("```") || trimmed.hasPrefix("~~~") {
                flushParagraph()
                let fence = String(trimmed.prefix(3))
                let language = trimmed.dropFirst(3).trimmingCharacters(in: .whitespaces)
                var codeLines: [String] = []
                index += 1
                while index < lines.count {
                    let current = lines[index]
                    if current.trimmingCharacters(in: .whitespaces).hasPrefix(fence) {
                        break
                    }
                    codeLines.append(current)
                    index += 1
                }
                index += 1
                blocks.append(.code(language: language.isEmpty ? nil : language, code: codeLines.joined(separator: "\n")))
                continue
            }

            if trimmed.isEmpty {
                flushParagraph()
                index += 1
                continue
            }

            if let heading = headingLevel(trimmed) {
                flushParagraph()
                let text = trimmed.dropFirst(heading).trimmingCharacters(in: .whitespaces)
                blocks.append(.heading(level: heading, text: stripClosingHashes(text)))
                index += 1
                continue
            }

            if isRule(trimmed) {
                flushParagraph()
                blocks.append(.rule)
                index += 1
                continue
            }

            if trimmed.hasPrefix("|") {
                flushParagraph()
                var tableLines: [String] = []
                while index < lines.count {
                    let current = lines[index].trimmingCharacters(in: .whitespaces)
                    if !current.hasPrefix("|") {
                        break
                    }
                    tableLines.append(current)
                    index += 1
                }
                blocks.append(.table(tableLines.joined(separator: "\n")))
                continue
            }

            if trimmed.hasPrefix(">") {
                flushParagraph()
                var quoteLines: [String] = []
                while index < lines.count {
                    let current = lines[index].trimmingCharacters(in: .whitespaces)
                    if !current.hasPrefix(">") {
                        break
                    }
                    var content = String(current.dropFirst())
                    if content.hasPrefix(" ") {
                        content.removeFirst()
                    }
                    quoteLines.append(content)
                    index += 1
                }
                blocks.append(.quote(quoteLines.joined(separator: "\n")))
                continue
            }

            if let item = listItem(line) {
                flushParagraph()
                blocks.append(item)
                index += 1
                continue
            }

            paragraph.append(line)
            index += 1
        }
        flushParagraph()
        return blocks
    }

    static func headingLevel(_ trimmed: String) -> Int? {
        var level = 0
        for character in trimmed {
            if character == "#" {
                level += 1
            } else {
                break
            }
        }
        guard level >= 1, level <= 6 else { return nil }
        let rest = trimmed.dropFirst(level)
        guard rest.isEmpty || rest.hasPrefix(" ") else { return nil }
        return level
    }

    static func stripClosingHashes(_ text: String) -> String {
        var result = text
        while result.hasSuffix("#") {
            result.removeLast()
        }
        return result.trimmingCharacters(in: .whitespaces)
    }

    static func isRule(_ trimmed: String) -> Bool {
        let compact = trimmed.replacingOccurrences(of: " ", with: "")
        guard compact.count >= 3, let first = compact.first, first == "-" || first == "*" || first == "_" else {
            return false
        }
        return compact.allSatisfy { $0 == first }
    }

    static func listItem(_ line: String) -> MarkdownBlock? {
        var spaces = 0
        for character in line {
            if character == " " {
                spaces += 1
            } else if character == "\t" {
                spaces += 4
            } else {
                break
            }
        }
        let content = line.trimmingCharacters(in: .whitespaces)
        let indent = spaces / 2
        if content.hasPrefix("- ") || content.hasPrefix("* ") || content.hasPrefix("+ ") {
            let text = String(content.dropFirst(2))
            return .listItem(ordered: false, marker: "•", text: text, indent: indent)
        }
        var digits = ""
        for character in content {
            if character.isASCII, character.isNumber {
                digits.append(character)
            } else {
                break
            }
        }
        guard !digits.isEmpty, digits.count <= 9 else { return nil }
        let rest = content.dropFirst(digits.count)
        if rest.hasPrefix(". ") || rest.hasPrefix(") ") {
            let text = String(rest.dropFirst(2))
            return .listItem(ordered: true, marker: digits + ".", text: text, indent: indent)
        }
        return nil
    }
}

public enum TextUtilities {
    /// Removes HTML tags (e.g. `<mark>` in search snippets) and decodes common entities.
    public static func stripHTML(_ html: String) -> String {
        var text = html.replacingOccurrences(of: "<[^>]+>", with: "", options: .regularExpression)
        let entities: [(String, String)] = [
            ("&lt;", "<"),
            ("&gt;", ">"),
            ("&quot;", "\""),
            ("&#39;", "'"),
            ("&#x27;", "'"),
            ("&nbsp;", " "),
            ("&amp;", "&"),
        ]
        for (entity, replacement) in entities {
            text = text.replacingOccurrences(of: entity, with: replacement)
        }
        return text
    }

    /// Friendly tool label: `mcp__github__search_issues` → `github · search issues`.
    public static func toolDisplayName(_ toolName: String) -> String {
        var name = toolName
        if name.hasPrefix("mcp__") {
            name = String(name.dropFirst(5))
        }
        let segments = name.components(separatedBy: "__").filter { !$0.isEmpty }
        let readable = segments.map { $0.replacingOccurrences(of: "_", with: " ") }
        let joined = readable.joined(separator: " · ")
        guard let first = joined.first else { return toolName }
        return first.uppercased() + joined.dropFirst()
    }
}
