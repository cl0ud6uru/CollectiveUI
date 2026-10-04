import Foundation

/// Incremental Server-Sent Events parser.
///
/// Feed it raw bytes (in any chunking) or complete lines; it emits the payload of each
/// event's `data:` field(s). Comment lines (`: keepalive`) and other fields are ignored,
/// and the AI SDK's terminal `data: [DONE]` is reported as `.done`.
public struct SSEParser: Sendable {
    public enum Event: Hashable, Sendable {
        case data(String)
        case done
    }

    private var dataLines: [String] = []
    private var lineBuffer: [UInt8] = []

    public init() {}

    /// Feeds a single byte. Returns an event when this byte completes one.
    public mutating func feed(byte: UInt8) -> Event? {
        if byte == 0x0A {
            let line = String(decoding: lineBuffer, as: UTF8.self)
            lineBuffer.removeAll(keepingCapacity: true)
            return consume(line: line)
        }
        lineBuffer.append(byte)
        return nil
    }

    /// Feeds a chunk of bytes, which may split lines (and UTF-8 sequences) anywhere.
    public mutating func feed(_ data: Data) -> [Event] {
        var events: [Event] = []
        for byte in data {
            if let event = feed(byte: byte) {
                events.append(event)
            }
        }
        return events
    }

    /// Convenience for tests: feeds the UTF-8 bytes of `text`.
    public mutating func feed(text: String) -> [Event] {
        return feed(Data(text.utf8))
    }

    /// Consumes one complete line (without its trailing `\n`).
    public mutating func consume(line rawLine: String) -> Event? {
        var line = rawLine
        if line.hasSuffix("\r") {
            line.removeLast()
        }
        if line.isEmpty {
            return dispatch()
        }
        if line.hasPrefix(":") {
            return nil
        }
        let field: Substring
        var value: Substring
        if let colon = line.firstIndex(of: ":") {
            field = line[line.startIndex..<colon]
            value = line[line.index(after: colon)...]
            if value.hasPrefix(" ") {
                value = value.dropFirst()
            }
        } else {
            field = line[line.startIndex...]
            value = ""
        }
        if field == "data" {
            dataLines.append(String(value))
        }
        return nil
    }

    /// Call at end of stream to flush a final event that was not followed by a blank line.
    public mutating func finish() -> Event? {
        if !lineBuffer.isEmpty {
            let line = String(decoding: lineBuffer, as: UTF8.self)
            lineBuffer.removeAll()
            if let event = consume(line: line) {
                return event
            }
        }
        return dispatch()
    }

    private mutating func dispatch() -> Event? {
        guard !dataLines.isEmpty else { return nil }
        let payload = dataLines.joined(separator: "\n")
        dataLines.removeAll()
        if payload.trimmingCharacters(in: .whitespaces) == "[DONE]" {
            return .done
        }
        return .data(payload)
    }
}
