import XCTest
import SwiftUI
import CollectiveKit
@testable import CollectiveUI

/// Measure the real view offscreen; never create a window or change keyboard focus.
@MainActor
final class DesktopCommandResultLayoutTests: XCTestCase {
    private func height(lines: [String], width: CGFloat, title: String = "Offline command result") throws -> CGFloat {
        let data = try JSONSerialization.data(withJSONObject: ["title": title, "lines": lines])
        let result = try JSONDecoder().decode(ChatCommandResult.self, from: data)
        let view = NSHostingView(rootView: DesktopCommandResultView(result: result, dismiss: {}).frame(width: width))
        view.layoutSubtreeIfNeeded()
        return view.fittingSize.height
    }

    func testHundredsOfLinesDoNotPushTheComposerOutOfACompactWindow() throws {
        let short = try height(lines: ["One line"], width: 400)
        let long = try height(lines: (1...200).map { "Offline result line \($0)" }, width: 400)
        XCTAssertGreaterThan(long, 160, "Output and its dismiss header need readable space")
        XCTAssertLessThan(long, 240, "Recovery output must leave space for the transcript and composer")
        XCTAssertEqual(long, short, accuracy: 1, "More output should scroll instead of growing the panel")
    }

    func testWrappedOutputRemainsBoundedAtNarrowAndWideWidths() throws {
        let lines = [String(repeating: "Long command output with no truncation. ", count: 300)]
        for width: CGFloat in [320, 900] {
            XCTAssertLessThan(try height(lines: lines, width: width), 240)
        }
    }

    func testLongResultTitleCannotPushDismissalAndComposerOffscreen() throws {
        let title = String(repeating: "A long command result title ", count: 80)
        XCTAssertLessThan(try height(lines: ["Body"], width: 320, title: title), 240)
    }

}
