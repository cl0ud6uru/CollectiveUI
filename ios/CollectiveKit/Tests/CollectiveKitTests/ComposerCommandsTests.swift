import XCTest
@testable import CollectiveKit

final class ComposerCommandsTests: XCTestCase {
    private var bot: TargetOption { TargetOption(kind: "bot", id: "bot-test", name: "Test") }
    private var hermes: TargetOption {
        var target = bot
        target.hermes = true
        return target
    }

    func testCommandChoicePreservesDraftAndLineBreaks() {
        XCTAssertEqual(ComposerCommands.inserting("/model", into: "/sta existing\nnotes"), "/model existing\nnotes")
        XCTAssertEqual(ComposerCommands.inserting("/status", into: "My existing draft"), "/status My existing draft")
        XCTAssertEqual(ComposerCommands.inserting("/help", into: ""), "/help ")
        XCTAssertEqual(ComposerCommands.inserting("/model", into: "/hermes sta notes"), "/model notes")
        XCTAssertEqual(ComposerCommands.inserting("/help", into: "//literal"), "/help //literal")
    }

    func testHermesCommandsAreSeparatedFromLiteralChat() {
        for text in ["/help", "/model allowed-model", "/unsupported", "/hermes status", "/portal new"] {
            XCTAssertTrue(ComposerCommands.isControl(text, target: hermes), text)
        }
        for text in ["//help", "/tmp/file", "Please explain /help", "Hello\n/help"] {
            XCTAssertFalse(ComposerCommands.isControl(text, target: hermes), text)
        }
    }

    func testNativeSkillsUseChatButFreshControlsUseCommandEndpoint() {
        XCTAssertTrue(ComposerCommands.isControl("/new", target: bot))
        XCTAssertTrue(ComposerCommands.isControl("/reset", target: bot))
        XCTAssertTrue(ComposerCommands.isControl("/portal new", target: bot))
        XCTAssertFalse(ComposerCommands.isControl("/my-skill", target: bot))
        XCTAssertFalse(ComposerCommands.isControl("/help", target: bot))
        XCTAssertFalse(ComposerCommands.isControl("/new", target: TargetOption(kind: "group", id: "g", name: "Group")))
        XCTAssertFalse(ComposerCommands.isControl("/new", target: TargetOption(kind: "app", id: "a", name: "Model")))
    }

    func testDoubleSlashEscapeDoesNotBecomeACommand() {
        XCTAssertEqual(ComposerCommands.messageText("//help", target: hermes), "/help")
        XCTAssertEqual(ComposerCommands.messageText("//new", target: bot), "/new")
        XCTAssertEqual(ComposerCommands.messageText("Line one\nLine two", target: bot), "Line one\nLine two")
    }

    func testOnlyServerAdvertisedHermesCommandsAreOfferedWhenCatalogExists() throws {
        let catalog = try JSONDecoder().decode(ChatCommandCatalog.self, from: Data(#"{"commands":[{"name":"status","description":"Status"}],"revision":3}"#.utf8))
        XCTAssertEqual(ComposerCommands.options(target: hermes, skills: [], catalog: catalog).map(\.value), ["/status"])
        XCTAssertEqual(ComposerCommands.options(target: bot, skills: [], catalog: nil).map(\.value), ["/new", "/reset"])
        XCTAssertTrue(ComposerCommands.options(target: TargetOption(kind: "group", id: "g", name: "Group"), skills: [], catalog: nil).isEmpty)
    }

    func testCommandNavigationAcceptsOnlyLocalConversationDestinations() throws {
        for path in ["https://evil.test/c/abcdefgh", "/c/../settings", "/settings", "/c/abc"] {
            let data = try JSONSerialization.data(withJSONObject: ["title": "Result", "lines": [], "navigateTo": path])
            XCTAssertNil(try JSONDecoder().decode(ChatCommandResult.self, from: data).destinationConversationId)
        }
        let result = try JSONDecoder().decode(ChatCommandResult.self, from: Data(#"{"title":"Result","lines":[],"navigateTo":"/c/abcdefgh_123"}"#.utf8))
        XCTAssertEqual(result.destinationConversationId, "abcdefgh_123")
    }
}
