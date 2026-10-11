import Foundation

// Only the platform route reader is stubbed. The production controller and store execute unchanged.
enum VoiceAudioRouteMetrics { static func snapshot() -> [String: Any] { ["sampleRate": 48000] } }

@MainActor @main struct VoiceAudioDiagnosticsLifecycleFixture {
    static func wait(_ condition: () -> Bool) async throws {
        for _ in 0..<1000 { if condition() { return }; try await Task.sleep(for: .milliseconds(1)) }
        preconditionFailure("Fixture timed out")
    }
    static func main() async throws {
        let diagnostics = VoiceAudioDiagnostics()
        var calls: [String] = []
        diagnostics.connect { operation in
            calls.append(operation)
            if operation == "sample" { return ["elapsedMs": 1, "stats": "available", "contexts": [:], "transcript": "PRIVATE"] }
            if operation == "report" { return ["events": [], "token": "PRIVATE"] }
            return true
        }
        precondition(calls.isEmpty && !diagnostics.enabled)
        await diagnostics.start(); try await wait { diagnostics.count == 1 }; await diagnostics.stop()
        let count = diagnostics.count; try await Task.sleep(for: .milliseconds(30))
        precondition(!diagnostics.enabled && diagnostics.count == count)
        let text = String(decoding: try await diagnostics.export(), as: UTF8.self)
        precondition(!text.contains("PRIVATE") && text.contains("sampleRate"))
        await diagnostics.clear(); precondition(diagnostics.count == 0)

        var pendingSample: CheckedContinuation<Any?, Never>?
        diagnostics.connect { operation in
            if operation == "sample" { return await withCheckedContinuation { pendingSample = $0 } }
            return true
        }
        await diagnostics.start(); try await wait { pendingSample != nil }; await diagnostics.stop()
        pendingSample?.resume(returning: ["elapsedMs": 1, "stats": "available"])
        try await Task.sleep(for: .milliseconds(10)); precondition(diagnostics.count == 0)

        var pendingStart: CheckedContinuation<Any?, Never>?
        diagnostics.connect { operation in
            if operation == "start" { return await withCheckedContinuation { pendingStart = $0 } }; return true
        }
        let starting = Task { await diagnostics.start() }
        try await wait { pendingStart != nil }; await diagnostics.clear(); pendingStart?.resume(returning: true)
        await starting.value; precondition(!diagnostics.enabled && !diagnostics.changing && diagnostics.count == 0)

        diagnostics.connect { _ in throw NSError(domain: "PRIVATE token", code: 1) }
        await diagnostics.start(); precondition(diagnostics.unavailable && !diagnostics.enabled && !diagnostics.changing)
        diagnostics.disconnect(); await diagnostics.start(); precondition(!diagnostics.enabled && diagnostics.count == 0 && !diagnostics.unavailable)
        print("Native diagnostic opt-in, stop/clear, stale sample/start cancellation, and export passed")
    }
}
