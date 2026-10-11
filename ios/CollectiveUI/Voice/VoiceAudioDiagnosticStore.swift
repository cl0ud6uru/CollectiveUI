import Foundation
import CoreFoundation

/// Defense in depth at the JavaScript boundary: accept only bounded numeric metrics and fixed enums.
struct VoiceAudioDiagnosticStore {
    private(set) var samples: [[String: Any]] = []
    static let limit = 180
    static let inbound = ["packetsReceivedDelta", "packetsLostDelta", "packetsDiscardedDelta", "concealedSamplesDelta", "concealmentEventsDelta", "totalSamplesReceivedDelta", "insertedSamplesForDecelerationDelta", "removedSamplesForAccelerationDelta", "jitterMs", "meanJitterBufferMs"]
    static let playout = ["synthesizedMsDelta", "synthesisEventsDelta", "samplesMsDelta", "meanPlayoutDelayMs"]
    static let renderer = ["frames", "meanFrameGapMs", "maxFrameGapMs", "gapsOver50Ms", "meanWorkMs", "maxWorkMs"]
    static let native = ["sampleRate", "ioBufferDurationMs", "inputLatencyMs", "outputLatencyMs", "categoryCode", "modeCode"]

    mutating func clear() { samples.removeAll(keepingCapacity: false) }
    mutating func append(_ javascript: Any?, native: [String: Any]) {
        guard samples.count < Self.limit, let source = javascript as? [String: Any],
              let elapsed = Self.number(source["elapsedMs"]), elapsed >= 0,
              let stats = Self.choice(source["stats"], ["available", "unavailable", "no-peer"]) else { return }
        var sample: [String: Any] = ["elapsedMs": elapsed, "stats": stats]
        for (key, fields) in [("inbound", Self.inbound), ("playout", Self.playout), ("renderer", Self.renderer)] {
            let values = Self.numbers(source[key], fields)
            if !values.isEmpty { sample[key] = values }
        }
        if let sourceContexts = source["contexts"] as? [String: Any] {
            var contexts: [String: Any] = [:]
            for role in ["input", "output"] {
                guard let value = sourceContexts[role] as? [String: Any],
                      let state = Self.choice(value["state"], ["running", "suspended", "closed", "interrupted", "unknown"]) else { continue }
                var context: [String: Any] = Self.numbers(value, ["sampleRate", "baseLatencyMs", "outputLatencyMs"])
                context["state"] = state; contexts[role] = context
            }
            sample["contexts"] = contexts
        }
        if let value = source["player"] as? [String: Any], let paused = Self.boolean(value["paused"]),
           let ready = Self.number(value["readyState"]), (0...4).contains(ready) {
            sample["player"] = ["paused": paused, "readyState": ready]
        }
        if let value = source["codec"] as? [String: Any],
           let mime = Self.choice(value["mime"], ["audio/opus", "audio/pcmu", "audio/pcma", "audio/g722", "other"]) {
            var codec: [String: Any] = ["mime": mime]
            if let rate = Self.number(value["clockRate"]) { codec["clockRate"] = rate }; sample["codec"] = codec
        }
        var route: [String: Any] = Self.numbers(native, Self.native)
        for key in ["inputPortCodes", "outputPortCodes"] {
            if let values = native[key] as? [Any] {
                route[key] = values.prefix(8).compactMap { value -> Int? in
                    guard let number = Self.number(value), number.rounded() == number, (0...20).contains(number) else { return nil }
                    return Int(number)
                }
            }
        }
        sample["native"] = route; samples.append(sample)
    }

    func data(javascript: Any?, recording: Bool) throws -> Data {
        let report = javascript as? [String: Any]
        var events: [[String: Any]] = []
        for value in ((report?["events"] as? [Any]) ?? []).prefix(32) {
            guard let event = value as? [String: Any], let elapsed = Self.number(event["elapsedMs"]), elapsed >= 0,
                  let duration = Self.number(event["durationMs"]), duration >= 0,
                  let kind = Self.choice(event["kind"], ["avatar-fetch", "avatar-decode", "avatar-load"]) else { continue }
            events.append(["elapsedMs": elapsed, "durationMs": duration, "kind": kind])
        }
        return try JSONSerialization.data(withJSONObject: ["schemaVersion": 1, "platform": "ios", "recording": recording, "samples": samples, "events": events], options: [.prettyPrinted, .sortedKeys])
    }
    private static func numbers(_ source: Any?, _ keys: [String]) -> [String: Any] {
        guard let source = source as? [String: Any] else { return [:] }
        var values: [String: Any] = [:]
        for key in keys { if let value = number(source[key]) { values[key] = value } }; return values
    }
    private static func number(_ value: Any?) -> Double? {
        guard let value = value as? NSNumber, CFGetTypeID(value) != CFBooleanGetTypeID() else { return nil }
        let number = value.doubleValue
        return number.isFinite && abs(number) <= 1e12 ? number : nil
    }
    private static func boolean(_ value: Any?) -> Bool? {
        guard let value = value as? NSNumber, CFGetTypeID(value) == CFBooleanGetTypeID() else { return nil }
        return value.boolValue
    }
    private static func choice(_ value: Any?, _ choices: [String]) -> String? {
        guard let string = value as? String, choices.contains(string) else { return nil }; return string
    }
}
