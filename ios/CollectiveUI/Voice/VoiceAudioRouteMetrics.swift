import AVFAudio

enum VoiceAudioRouteMetrics {
    static func snapshot() -> [String: Any] {
        let session = AVAudioSession.sharedInstance()
        let categories: [AVAudioSession.Category] = [.playAndRecord, .playback, .record, .ambient, .soloAmbient, .multiRoute]
        let modes: [AVAudioSession.Mode] = [.voiceChat, .videoChat, .default, .measurement, .gameChat, .spokenAudio, .moviePlayback, .videoRecording, .voicePrompt]
        let ports: [AVAudioSession.Port] = [.builtInMic, .builtInSpeaker, .builtInReceiver, .headphones, .headsetMic, .bluetoothHFP, .bluetoothA2DP, .bluetoothLE, .airPlay, .usbAudio, .lineIn, .lineOut, .HDMI, .carAudio]
        func portCode(_ port: AVAudioSessionPortDescription) -> Int { ports.firstIndex(of: port.portType).map { $0 + 1 } ?? 0 }
        return ["sampleRate": session.sampleRate, "ioBufferDurationMs": session.ioBufferDuration * 1000,
                "inputLatencyMs": session.inputLatency * 1000, "outputLatencyMs": session.outputLatency * 1000,
                "categoryCode": categories.firstIndex(of: session.category).map { $0 + 1 } ?? 0,
                "modeCode": modes.firstIndex(of: session.mode).map { $0 + 1 } ?? 0,
                "inputPortCodes": session.currentRoute.inputs.prefix(8).map(portCode),
                "outputPortCodes": session.currentRoute.outputs.prefix(8).map(portCode)]
    }
}
