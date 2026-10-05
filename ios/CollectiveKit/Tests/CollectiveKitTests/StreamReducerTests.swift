import XCTest
@testable import CollectiveKit

final class StreamReducerTests: XCTestCase {
    private func chunk(_ json: String, file: StaticString = #filePath, line: UInt = #line) -> UIMessageChunk {
        guard let parsed = UIMessageChunk.parse(json) else {
            XCTFail("Invalid chunk JSON: \(json)", file: file, line: line)
            return .unknown(type: "")
        }
        return parsed
    }

    private func apply(_ reducer: inout UIMessageStreamReducer, _ chunks: [String]) -> [StreamEvent] {
        var events: [StreamEvent] = []
        for json in chunks {
            events.append(contentsOf: reducer.apply(chunk(json)))
        }
        return events
    }

    func testTextDeltasAccumulate() {
        var reducer = UIMessageStreamReducer(messageId: "placeholder")
        let events = apply(&reducer, [
            #"{"type":"start","messageId":"msg1"}"#,
            #"{"type":"start-step"}"#,
            #"{"type":"text-start","id":"t1"}"#,
            #"{"type":"text-delta","id":"t1","delta":"Hello"}"#,
            #"{"type":"text-delta","id":"t1","delta":", world"}"#,
            #"{"type":"text-end","id":"t1"}"#,
            #"{"type":"finish-step"}"#,
            #"{"type":"finish","finishReason":"stop"}"#,
        ])
        XCTAssertEqual(reducer.message.id, "msg1")
        XCTAssertEqual(reducer.message.role, .assistant)
        XCTAssertEqual(reducer.message.plainText, "Hello, world")
        XCTAssertTrue(reducer.isFinished)
        XCTAssertTrue(events.contains(.started(messageId: "msg1")))
        XCTAssertTrue(events.contains(.finished(reason: "stop")))
        guard case .text(let text)? = reducer.message.parts.last else {
            return XCTFail("Expected a text part")
        }
        XCTAssertEqual(text.state, "done")
    }

    func testDeltaWithoutStartCreatesPart() {
        var reducer = UIMessageStreamReducer(messageId: "m")
        _ = apply(&reducer, [#"{"type":"text-delta","id":"x","delta":"abc"}"#])
        XCTAssertEqual(reducer.message.plainText, "abc")
    }

    func testSeparateTextBlocksAcrossSteps() {
        var reducer = UIMessageStreamReducer(messageId: "m")
        _ = apply(&reducer, [
            #"{"type":"text-start","id":"0"}"#,
            #"{"type":"text-delta","id":"0","delta":"first"}"#,
            #"{"type":"text-end","id":"0"}"#,
            #"{"type":"text-start","id":"0"}"#,
            #"{"type":"text-delta","id":"0","delta":"second"}"#,
            #"{"type":"text-end","id":"0"}"#,
        ])
        XCTAssertEqual(reducer.message.plainText, "first\n\nsecond")
    }

    func testReasoningParts() {
        var reducer = UIMessageStreamReducer(messageId: "m")
        _ = apply(&reducer, [
            #"{"type":"reasoning-start","id":"r"}"#,
            #"{"type":"reasoning-delta","id":"r","delta":"Let me "}"#,
            #"{"type":"reasoning-delta","id":"r","delta":"think"}"#,
            #"{"type":"reasoning-end","id":"r"}"#,
            #"{"type":"text-start","id":"t"}"#,
            #"{"type":"text-delta","id":"t","delta":"Answer"}"#,
        ])
        XCTAssertEqual(reducer.message.parts.count, 2)
        guard case .reasoning(let reasoning) = reducer.message.parts[0] else {
            return XCTFail("Expected reasoning first")
        }
        XCTAssertEqual(reducer.message.plainText, "Answer")
        XCTAssertEqual(reasoning.text, "Let me think")
        XCTAssertEqual(reasoning.state, "done")
    }

    func testToolLifecycle() {
        var reducer = UIMessageStreamReducer(messageId: "m")
        _ = apply(&reducer, [
            #"{"type":"tool-input-start","toolCallId":"call1","toolName":"web_search"}"#,
            #"{"type":"tool-input-delta","toolCallId":"call1","inputTextDelta":"{\"query\":"}"#,
            #"{"type":"tool-input-delta","toolCallId":"call1","inputTextDelta":"\"swift\"}"}"#,
        ])
        guard case .tool(let streaming)? = reducer.message.parts.first else {
            return XCTFail("Expected tool part")
        }
        XCTAssertEqual(streaming.type, "tool-web_search")
        XCTAssertEqual(streaming.state, "input-streaming")
        XCTAssertEqual(streaming.inputText, "{\"query\":\"swift\"}")
        XCTAssertEqual(streaming.input?["query"]?.stringValue, "swift")

        _ = apply(&reducer, [
            #"{"type":"tool-input-available","toolCallId":"call1","toolName":"web_search","input":{"query":"swift"}}"#,
            #"{"type":"tool-output-available","toolCallId":"call1","output":{"results":[1,2]}}"#,
        ])
        guard case .tool(let done)? = reducer.message.parts.first else {
            return XCTFail("Expected tool part")
        }
        XCTAssertEqual(reducer.message.parts.count, 1)
        XCTAssertEqual(done.state, "output-available")
        XCTAssertEqual(done.phase, .completed)
        XCTAssertEqual(done.output?["results"]?.arrayValue?.count, 2)
    }

    func testDynamicToolAndErrors() {
        var reducer = UIMessageStreamReducer(messageId: "m")
        _ = apply(&reducer, [
            #"{"type":"tool-input-available","toolCallId":"c","toolName":"mcp__github__search","input":{},"dynamic":true,"title":"Search GitHub"}"#,
            #"{"type":"tool-output-error","toolCallId":"c","errorText":"boom"}"#,
        ])
        guard case .tool(let tool)? = reducer.message.parts.first else {
            return XCTFail("Expected tool part")
        }
        XCTAssertEqual(tool.type, "dynamic-tool")
        XCTAssertEqual(tool.toolName, "mcp__github__search")
        XCTAssertEqual(tool.title, "Search GitHub")
        XCTAssertEqual(tool.state, "output-error")
        XCTAssertEqual(tool.errorText, "boom")
        XCTAssertEqual(tool.phase, .failed)
    }

    func testApprovalRequestAndResponse() {
        var reducer = UIMessageStreamReducer(messageId: "m")
        _ = apply(&reducer, [
            #"{"type":"start","messageId":"assistant1"}"#,
            #"{"type":"tool-input-available","toolCallId":"c1","toolName":"send_email","input":{"to":"a@b.c"}}"#,
            #"{"type":"tool-approval-request","approvalId":"ap1","toolCallId":"c1"}"#,
            #"{"type":"finish"}"#,
        ])
        guard case .tool(let requested)? = reducer.message.parts.first else {
            return XCTFail("Expected tool part")
        }
        XCTAssertEqual(requested.state, "approval-requested")
        XCTAssertEqual(requested.approval?.id, "ap1")
        XCTAssertEqual(requested.phase, .awaitingApproval)
        XCTAssertEqual(reducer.message.pendingApprovals.count, 1)

        // Continue the same message after the user answered.
        var answered = reducer.message
        if case .tool(var part) = answered.parts[0] {
            part.state = "approval-responded"
            part.approval = ToolApproval(id: "ap1", approved: true)
            answered.parts[0] = .tool(part)
        }
        var continuation = UIMessageStreamReducer(continuing: answered)
        _ = apply(&continuation, [
            #"{"type":"start","messageId":"something-else"}"#,
            #"{"type":"tool-approval-response","approvalId":"ap1","approved":true}"#,
            #"{"type":"tool-output-available","toolCallId":"c1","output":"sent"}"#,
            #"{"type":"text-start","id":"t"}"#,
            #"{"type":"text-delta","id":"t","delta":"Done."}"#,
            #"{"type":"finish"}"#,
        ])
        XCTAssertEqual(continuation.message.id, "assistant1")
        XCTAssertEqual(continuation.message.parts.count, 2)
        guard case .tool(let finished) = continuation.message.parts[0] else {
            return XCTFail("Expected tool part")
        }
        XCTAssertEqual(finished.state, "output-available")
        XCTAssertEqual(finished.approval?.approved, true)
        XCTAssertEqual(finished.output, .string("sent"))
        XCTAssertEqual(continuation.message.plainText, "Done.")
    }

    func testDeniedTool() {
        var reducer = UIMessageStreamReducer(messageId: "m")
        _ = apply(&reducer, [
            #"{"type":"tool-input-available","toolCallId":"c1","toolName":"delete_file","input":{}}"#,
            #"{"type":"tool-approval-request","approvalId":"ap","toolCallId":"c1"}"#,
            #"{"type":"tool-approval-response","approvalId":"ap","approved":false,"reason":"no"}"#,
            #"{"type":"tool-output-denied","toolCallId":"c1"}"#,
        ])
        guard case .tool(let tool)? = reducer.message.parts.first else {
            return XCTFail("Expected tool part")
        }
        XCTAssertEqual(tool.state, "output-denied")
        XCTAssertEqual(tool.approval?.approved, false)
        XCTAssertEqual(tool.approval?.reason, "no")
        XCTAssertEqual(tool.phase, .denied)
    }

    func testDataTitleNoticeAndTransient() {
        var reducer = UIMessageStreamReducer(messageId: "m")
        let events = apply(&reducer, [
            #"{"type":"data-title","data":{"title":"Trip plan"},"transient":true}"#,
            #"{"type":"data-notice","data":{"message":"Switched model"},"transient":true}"#,
            #"{"type":"data-speaker","id":"s1","data":{"botId":"b","name":"Moss","avatar":"blob:circle:teal"}}"#,
            #"{"type":"data-speaker","id":"s1","data":{"botId":"b","name":"Moss 2","avatar":"blob:circle:teal"}}"#,
        ])
        XCTAssertTrue(events.contains(.title("Trip plan")))
        XCTAssertTrue(events.contains(.notice("Switched model")))
        XCTAssertEqual(reducer.message.parts.count, 1)
        guard case .data(let speaker) = reducer.message.parts[0] else {
            return XCTFail("Expected data part")
        }
        XCTAssertEqual(speaker.name, "speaker")
        XCTAssertEqual(speaker.data["name"]?.stringValue, "Moss 2")
    }

    func testErrorChunk() {
        var reducer = UIMessageStreamReducer(messageId: "m")
        let events = apply(&reducer, [#"{"type":"error","errorText":"Rate limited"}"#])
        XCTAssertEqual(events, [.error("Rate limited")])
        XCTAssertEqual(reducer.errorText, "Rate limited")
    }

    func testRunErrorDataPartIsKept() {
        var reducer = UIMessageStreamReducer(messageId: "m")
        _ = apply(&reducer, [#"{"type":"data-run-error","data":{"message":"Model unavailable"}}"#])
        XCTAssertTrue(reducer.message.hasVisibleContent)
    }

    func testMetadataMergesAndUnknownChunksAreIgnored() {
        var reducer = UIMessageStreamReducer(messageId: "m")
        _ = apply(&reducer, [
            #"{"type":"start","messageMetadata":{"model":"gpt"}}"#,
            #"{"type":"something-new","foo":1}"#,
            #"{"type":"message-metadata","messageMetadata":{"finishedAt":5}}"#,
            #"{"type":"source-url","sourceId":"s","url":"https://example.com","title":"Example"}"#,
            #"{"type":"file","url":"/api/files/abc","mediaType":"image/png"}"#,
            #"{"type":"abort"}"#,
        ])
        XCTAssertEqual(reducer.message.id, "m")
        XCTAssertEqual(reducer.message.metadata?["model"]?.stringValue, "gpt")
        XCTAssertEqual(reducer.message.metadata?["finishedAt"]?.intValue, 5)
        XCTAssertEqual(reducer.message.parts.count, 2)
        XCTAssertEqual(reducer.message.files.first?.url, "/api/files/abc")
        XCTAssertTrue(reducer.isFinished)
    }
}
