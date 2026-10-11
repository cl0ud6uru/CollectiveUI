import Foundation

@main struct VoiceAudioDiagnosticStoreFixture {
    static func main() throws {
        var store = VoiceAudioDiagnosticStore()
        let sample: [String: Any] = ["elapsedMs": 1000, "stats": "available", "transcript": "PRIVATE", "sdp": "PRIVATE",
            "inbound": ["jitterMs": 3, "packetsLostDelta": -1, "concealedSamplesDelta": Double.nan, "secret": "PRIVATE"],
            "contexts": ["input": ["state": "running", "sampleRate": 48000, "baseLatencyMs": 10, "label": "PRIVATE"], "secret": ["state": "PRIVATE"]],
            "codec": ["mime": "audio/opus", "clockRate": 48000, "id": "PRIVATE"], "player": ["paused": false, "readyState": 4]]
        let native: [String: Any] = ["sampleRate": 48000, "ioBufferDurationMs": 10, "inputPortCodes": [1, 999, "PRIVATE"], "outputPortCodes": [2], "portName": "PRIVATE", "uid": "PRIVATE"]
        store.append(sample, native: native)
        let events: [String: Any] = ["events": [["elapsedMs": 900, "durationMs": 20, "kind": "avatar-decode", "body": "PRIVATE"], ["elapsedMs": 900, "durationMs": 20, "kind": "PRIVATE"]], "token": "PRIVATE"]
        let data = try store.data(javascript: events, recording: false)
        let text = String(decoding: data, as: UTF8.self)
        precondition(!text.contains("PRIVATE") && !text.contains("transcript") && !text.contains("sdp") && !text.contains("uid"))
        let report = try JSONSerialization.jsonObject(with: data) as! [String: Any]
        let rows = report["samples"] as! [[String: Any]]
        precondition(rows.count == 1 && (report["events"] as! [Any]).count == 1)
        precondition((rows[0]["inbound"] as! [String: Any])["concealedSamplesDelta"] == nil)
        precondition((rows[0]["native"] as! [String: Any])["inputPortCodes"] as! [Int] == [1])
        store.append(["elapsedMs": true, "stats": "available"], native: [:])
        store.append(["elapsedMs": 1, "stats": "PRIVATE"], native: [:])
        precondition(store.samples.count == 1)
        for _ in 0..<250 { store.append(sample, native: native) }; precondition(store.samples.count == 180)
        store.clear(); precondition(store.samples.isEmpty)
        print("Native diagnostic allowlist, missing values, redaction, and bounds passed")
    }
}
