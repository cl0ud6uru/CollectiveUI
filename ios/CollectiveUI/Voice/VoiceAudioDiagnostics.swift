import Foundation
import Observation

/// Local-only metadata; reading AVAudioSession does not activate it or change its configuration.
@MainActor @Observable
final class VoiceAudioDiagnostics {
    private(set) var enabled = false
    private(set) var changing = false
    private(set) var count = 0
    private(set) var unavailable = false
    @ObservationIgnored private var store = VoiceAudioDiagnosticStore()
    @ObservationIgnored private var command: ((String) async throws -> Any?)?
    @ObservationIgnored private var capture: Task<Void, Never>?
    @ObservationIgnored private var epoch = 0
    @ObservationIgnored private let route: () -> [String: Any]

    init(route: @escaping () -> [String: Any] = VoiceAudioRouteMetrics.snapshot) { self.route = route }

    /// The session supplies a weak closure to window.voice.diagnostics; no session IDs enter exports.
    func connect(_ command: @escaping (String) async throws -> Any?) { self.command = command }
    /// Call before discarding the page. This cannot delay microphone shutdown or page disposal.
    func disconnect() {
        enabled = false; changing = false; epoch += 1; capture?.cancel(); capture = nil; command = nil
        store.clear(); count = 0; unavailable = false
    }
    func start() async {
        guard !enabled, !changing, let command else { return }
        changing = true; epoch += 1; let current = epoch
        do {
            let result = try await command("start")
            guard current == epoch else { return }
            guard result as? Bool == true else { changing = false; unavailable = true; return }
            store.clear(); count = 0; unavailable = false; enabled = true; changing = false
            capture = Task { [weak self] in
                while !Task.isCancelled {
                    guard let self, self.enabled, self.epoch == current else { return }
                    do {
                        let sample = try await command("sample")
                        guard !Task.isCancelled, self.enabled, self.epoch == current else { return }
                        let before = self.store.samples.count
                        self.store.append(sample, native: self.route())
                        self.count = self.store.samples.count
                        self.unavailable = self.count == before || (sample as? [String: Any])?["stats"] as? String != "available"
                        if !(sample is [String: Any]) || self.count >= VoiceAudioDiagnosticStore.limit { await self.stop(); return }
                    } catch {
                        guard self.epoch == current else { return }; self.unavailable = true
                        await self.stop(); return
                    }
                    do { try await Task.sleep(for: .seconds(1)) } catch { return }
                }
            }
        } catch {
            guard current == epoch else { return }; changing = false; unavailable = true
        }
    }
    func stop() async {
        enabled = false; changing = true; epoch += 1; let current = epoch; capture?.cancel(); capture = nil
        _ = try? await command?("stop")
        if current == epoch { changing = false }
    }
    func clear() async {
        await stop(); changing = true; epoch += 1; let current = epoch
        _ = try? await command?("clear")
        guard current == epoch else { return }; changing = false
        store.clear(); count = 0; unavailable = false
    }
    func export() async throws -> Data {
        let javascript = try? await command?("report")
        return try store.data(javascript: javascript, recording: enabled)
    }
}
