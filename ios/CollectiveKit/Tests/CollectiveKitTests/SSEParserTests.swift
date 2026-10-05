import XCTest
@testable import CollectiveKit

final class SSEParserTests: XCTestCase {
    func testParsesSimpleEvents() {
        var parser = SSEParser()
        let events = parser.feed(text: "data: {\"type\":\"start\"}\n\ndata: {\"type\":\"finish\"}\n\n")
        XCTAssertEqual(events, [.data("{\"type\":\"start\"}"), .data("{\"type\":\"finish\"}")])
    }

    func testIgnoresKeepaliveCommentsAndOtherFields() {
        var parser = SSEParser()
        let input = ": keepalive\n\nevent: message\nid: 7\nretry: 1000\ndata: hello\n\n: keepalive\n\n"
        let events = parser.feed(text: input)
        XCTAssertEqual(events, [.data("hello")])
    }

    func testDoneMarker() {
        var parser = SSEParser()
        let events = parser.feed(text: "data: {\"type\":\"finish\"}\n\ndata: [DONE]\n\n")
        XCTAssertEqual(events, [.data("{\"type\":\"finish\"}"), .done])
    }

    func testHandlesChunksSplitAnywhere() {
        let input = "data: {\"type\":\"text-delta\",\"id\":\"t\",\"delta\":\"héllo 👋\"}\n\n: keepalive\n\ndata: [DONE]\n\n"
        let bytes = Array(input.utf8)
        for chunkSize in 1...9 {
            var parser = SSEParser()
            var events: [SSEParser.Event] = []
            var start = 0
            while start < bytes.count {
                let end = min(start + chunkSize, bytes.count)
                events.append(contentsOf: parser.feed(Data(bytes[start..<end])))
                start = end
            }
            XCTAssertEqual(events, [
                .data("{\"type\":\"text-delta\",\"id\":\"t\",\"delta\":\"héllo 👋\"}"),
                .done,
            ], "chunk size \(chunkSize)")
        }
    }

    func testCRLFLineEndings() {
        var parser = SSEParser()
        let events = parser.feed(text: "data: one\r\n\r\ndata: two\r\n\r\n")
        XCTAssertEqual(events, [.data("one"), .data("two")])
    }

    func testMultiLineDataIsJoined() {
        var parser = SSEParser()
        let events = parser.feed(text: "data: a\ndata: b\n\n")
        XCTAssertEqual(events, [.data("a\nb")])
    }

    func testDataWithoutSpaceAfterColon() {
        var parser = SSEParser()
        let events = parser.feed(text: "data:{\"x\":1}\n\n")
        XCTAssertEqual(events, [.data("{\"x\":1}")])
    }

    func testFinishFlushesTrailingEvent() {
        var parser = SSEParser()
        let events = parser.feed(text: "data: tail")
        XCTAssertTrue(events.isEmpty)
        XCTAssertEqual(parser.finish(), .data("tail"))
        XCTAssertNil(parser.finish())
    }

    func testLinesFeedThroughConsume() {
        var parser = SSEParser()
        XCTAssertNil(parser.consume(line: "data: x"))
        XCTAssertEqual(parser.consume(line: ""), .data("x"))
        XCTAssertNil(parser.consume(line: ": keepalive"))
        XCTAssertNil(parser.consume(line: ""))
    }

    func testChunksDecodeFromPayloads() {
        var parser = SSEParser()
        let input = "data: {\"type\":\"text-start\",\"id\":\"a\"}\n\ndata: {\"type\":\"text-delta\",\"id\":\"a\",\"delta\":\"Hi\"}\n\ndata: [DONE]\n\n"
        var chunks: [UIMessageChunk] = []
        for event in parser.feed(text: input) {
            if case .data(let payload) = event, let chunk = UIMessageChunk.parse(payload) {
                chunks.append(chunk)
            }
        }
        XCTAssertEqual(chunks, [.textStart(id: "a"), .textDelta(id: "a", delta: "Hi")])
    }
}
