import XCTest
@testable import CollectiveKit

final class MarkdownParserTests: XCTestCase {
    func testBlocks() {
        let source = """
        # Title
        Some **bold** text
        continues here.

        - one
          - nested
        2. two

        > quoted
        > more

        ```swift
        let x = 1
        ```

        | a | b |
        |---|---|
        | 1 | 2 |

        ---
        Tail
        """
        let blocks = MarkdownParser.blocks(from: source)
        XCTAssertEqual(blocks, [
            .heading(level: 1, text: "Title"),
            .paragraph("Some **bold** text\ncontinues here."),
            .listItem(ordered: false, marker: "•", text: "one", indent: 0),
            .listItem(ordered: false, marker: "•", text: "nested", indent: 1),
            .listItem(ordered: true, marker: "2.", text: "two", indent: 0),
            .quote("quoted\nmore"),
            .code(language: "swift", code: "let x = 1"),
            .table("| a | b |\n|---|---|\n| 1 | 2 |"),
            .rule,
            .paragraph("Tail"),
        ])
    }

    func testUnterminatedFenceKeepsCode() {
        let blocks = MarkdownParser.blocks(from: "```\nstreaming code")
        XCTAssertEqual(blocks, [.code(language: nil, code: "streaming code")])
    }

    func testHashtagIsNotHeading() {
        XCTAssertEqual(MarkdownParser.blocks(from: "#hashtag"), [.paragraph("#hashtag")])
    }

    func testToolDisplayName() {
        XCTAssertEqual(TextUtilities.toolDisplayName("mcp__github__search_issues"), "Github · search issues")
        XCTAssertEqual(TextUtilities.toolDisplayName("web_search"), "Web search")
    }
}
