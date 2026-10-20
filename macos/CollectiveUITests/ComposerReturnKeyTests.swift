import AppKit
import XCTest
@testable import CollectiveUI

@MainActor
final class ComposerReturnKeyTests: XCTestCase {
    private var window: NSWindow!
    private var editor: NSTextView!
    private var probe: ComposerReturnKeyView!
    private var submissions = 0

    override func setUp() {
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 400, height: 200),
            styleMask: .titled, backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        editor = NSTextView(frame: NSRect(x: 0, y: 0, width: 400, height: 200))
        editor.setAccessibilityIdentifier("chat.composer")
        editor.string = "Unsent draft"
        probe = ComposerReturnKeyView { [weak self] in
            self?.submissions += 1
            return true
        }
        window.contentView?.addSubview(editor)
        window.contentView?.addSubview(probe)
        XCTAssertTrue(window.makeFirstResponder(editor))
    }

    override func tearDown() {
        probe.stopMonitoring()
        window.close()
        probe = nil
        editor = nil
        window = nil
    }

    private func key(_ flags: NSEvent.ModifierFlags = [], repeated: Bool = false,
                     code: UInt16 = 36, windowNumber: Int? = nil) -> NSEvent {
        NSEvent.keyEvent(with: .keyDown, location: .zero, modifierFlags: flags,
            timestamp: 0, windowNumber: windowNumber ?? window.windowNumber, context: nil,
            characters: "\r", charactersIgnoringModifiers: "\r", isARepeat: repeated, keyCode: code)!
    }

    func testEnterSendsOnceAndConsumesKeyRepeatWithoutChangingDraft() {
        XCTAssertNil(probe.handle(key()))
        XCTAssertNil(probe.handle(key(repeated: true)))
        XCTAssertNil(probe.handle(key(repeated: true)))
        XCTAssertEqual(submissions, 1)
        XCTAssertEqual(editor.string, "Unsent draft")
    }

    func testShiftEnterPassesUnchangedToNativeEditor() {
        let event = key(.shift)
        XCTAssertTrue(probe.handle(event) === event)
        XCTAssertEqual(submissions, 0)
        XCTAssertEqual(editor.string, "Unsent draft")
    }

    func testMarkedTextIsUntouchedAndReturnDoesNotSend() {
        editor.setSelectedRange(NSRange(location: 0, length: editor.string.utf16.count))
        editor.setMarkedText("にほん", selectedRange: NSRange(location: 3, length: 0),
            replacementRange: NSRange(location: NSNotFound, length: 0))
        XCTAssertTrue(editor.hasMarkedText())
        let original = editor.string
        let markedRange = editor.markedRange()
        let event = key()
        XCTAssertTrue(probe.handle(event) === event)
        XCTAssertEqual(submissions, 0)
        XCTAssertEqual(editor.string, original)
        XCTAssertEqual(editor.markedRange(), markedRange)
    }

    func testMenuShortcutsAndOtherModifiedReturnsPassThrough() {
        for flags: NSEvent.ModifierFlags in [.command, .option, .control, [.shift, .command]] {
            let event = key(flags)
            XCTAssertTrue(probe.handle(event) === event)
        }
        XCTAssertEqual(submissions, 0)
    }

    func testOnlyTheEditableComposerInTheSameWindowCanSubmit() {
        let event = key()
        editor.setAccessibilityIdentifier("another.editor")
        XCTAssertTrue(probe.handle(event) === event)
        editor.setAccessibilityIdentifier("chat.composer")
        editor.isFieldEditor = true
        XCTAssertTrue(probe.handle(event) === event)
        editor.isFieldEditor = false
        editor.isEditable = false
        XCTAssertTrue(probe.handle(event) === event)
        editor.isEditable = true
        let otherWindow = key(windowNumber: window.windowNumber + 1)
        XCTAssertTrue(probe.handle(otherWindow) === otherWindow)
        XCTAssertEqual(submissions, 0)
    }

    func testKeypadEnterAndCapsLockStillSubmit() {
        XCTAssertNil(probe.handle(key(.numericPad, code: 76)))
        XCTAssertNil(probe.handle(key(.capsLock)))
        XCTAssertEqual(submissions, 2)
    }

    func testDetachedOrInactiveOwnerDoesNotInterceptReturn() {
        probe.onReturn = { false }
        let event = key()
        XCTAssertTrue(probe.handle(event) === event)
        probe.removeFromSuperview()
        XCTAssertTrue(probe.handle(event) === event)
        XCTAssertEqual(submissions, 0)
    }
}
