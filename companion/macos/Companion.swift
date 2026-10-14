import AppKit
import Foundation
import Darwin

struct ProtectedFailure: Error {}
func check(_ condition: Bool) throws { if !condition { throw ProtectedFailure() } }
func validName(_ name: String) -> Bool { name.range(of: "^[a-z0-9][a-z0-9.-]{0,100}$", options: .regularExpression) != nil }
final class ProtectedDirectory {
    let fd: Int32
    var lockFD: Int32 = -1
    init(_ path: String) throws {
        try check(path.hasPrefix("/") && !path.contains("\u{0}"))
        let pieces = path.split(separator: "/", omittingEmptySubsequences: true).map(String.init)
        try check(!pieces.isEmpty && !pieces.contains(".") && !pieces.contains(".."))
        var current = Darwin.open("/", O_RDONLY | O_DIRECTORY | O_NOFOLLOW)
        try check(current >= 0)
        do {
            for (index, piece) in pieces.enumerated() {
                var next = openat(current, piece, O_RDONLY | O_DIRECTORY | O_NOFOLLOW)
                if next < 0 && errno == ENOENT {
                    // Only the dedicated final directory may be created. Its parent is prepared by the signed launcher.
                    try check(index == pieces.count - 1)
                    try check(mkdirat(current, piece, 0o700) == 0 || errno == EEXIST)
                    next = openat(current, piece, O_RDONLY | O_DIRECTORY | O_NOFOLLOW)
                }
                try check(next >= 0); Darwin.close(current); current = next
            }
            var info = stat(); try check(fstat(current, &info) == 0 && (info.st_mode & S_IFMT) == S_IFDIR && info.st_uid == getuid() && (info.st_mode & 0o777) == 0o700)
            fd = current
        } catch { Darwin.close(current); throw error }
    }
    deinit { if lockFD >= 0 { Darwin.close(lockFD) }; Darwin.close(fd) }
    func file(_ name: String, flags: Int32, mode: mode_t = 0) throws -> Int32 {
        try check(validName(name)); let result = openat(fd, name, flags | O_NOFOLLOW | O_NONBLOCK, mode); try check(result >= 0)
        var info = stat()
        do { try check(fstat(result, &info) == 0 && (info.st_mode & S_IFMT) == S_IFREG && info.st_uid == getuid() && (info.st_mode & 0o777) == 0o600 && info.st_nlink == 1 && info.st_size <= 128000); return result }
        catch { Darwin.close(result); throw error }
    }
    func read(_ name: String) throws -> String? {
        try check(validName(name))
        if faccessat(fd, name, F_OK, AT_SYMLINK_NOFOLLOW) != 0 && errno == ENOENT { return nil }
        let handle = try file(name, flags: O_RDONLY); defer { Darwin.close(handle) }
        var before = stat(); try check(fstat(handle, &before) == 0 && before.st_size > 0)
        var data = [UInt8](repeating: 0, count: 128001); let count = Darwin.read(handle, &data, data.count)
        var after = stat(); try check(fstat(handle, &after) == 0 && count == before.st_size && after.st_size == before.st_size && after.st_mtimespec.tv_sec == before.st_mtimespec.tv_sec && after.st_mtimespec.tv_nsec == before.st_mtimespec.tv_nsec && after.st_ctimespec.tv_sec == before.st_ctimespec.tv_sec && after.st_ctimespec.tv_nsec == before.st_ctimespec.tv_nsec)
        guard let text = String(bytes: data.prefix(count), encoding: .utf8) else { throw ProtectedFailure() }; return text
    }
    func write(_ name: String, data: String) throws {
        try check(validName(name)); let bytes = Array(data.utf8); try check(!bytes.isEmpty && bytes.count <= 128000)
        var targetInfo = stat()
        if fstatat(fd, name, &targetInfo, AT_SYMLINK_NOFOLLOW) == 0 { try check((targetInfo.st_mode & S_IFMT) == S_IFREG && targetInfo.st_uid == getuid() && (targetInfo.st_mode & 0o777) == 0o600 && targetInfo.st_nlink == 1) }
        else { try check(errno == ENOENT) }
        let temporary = "tmp-" + UUID().uuidString.lowercased()
        let handle = try file(temporary, flags: O_WRONLY | O_CREAT | O_EXCL, mode: 0o600)
        defer { Darwin.close(handle); unlinkat(fd, temporary, 0) }
        var offset = 0
        try bytes.withUnsafeBytes { buffer in
            while offset < bytes.count { let n = Darwin.write(handle, buffer.baseAddress!.advanced(by: offset), bytes.count - offset); try check(n > 0); offset += n }
        }
        try check(fsync(handle) == 0 && renameat(fd, temporary, fd, name) == 0 && fsync(fd) == 0)
    }
    func lock() throws { try check(lockFD < 0); let handle = try file("operation.lock", flags: O_RDWR | O_CREAT, mode: 0o600); if flock(handle, LOCK_EX | LOCK_NB) != 0 { Darwin.close(handle); throw ProtectedFailure() }; lockFD = handle }
    func unlock() throws { try check(lockFD >= 0); try check(flock(lockFD, LOCK_UN) == 0); Darwin.close(lockFD); lockFD = -1 }
    func isLocked() throws -> Bool { if lockFD >= 0 { return true }; let handle = try file("operation.lock", flags: O_RDWR | O_CREAT, mode: 0o600); defer { Darwin.close(handle) }; if flock(handle, LOCK_EX | LOCK_NB) != 0 { try check(errno == EWOULDBLOCK); return true }; flock(handle, LOCK_UN); return false }
}
func emit(_ value: [String: Any]) { if let data = try? JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]) { FileHandle.standardOutput.write(data); FileHandle.standardOutput.write(Data([10])) } }
func storeMain(_ root: String) throws {
    let directory = try ProtectedDirectory(root)
    while let line = readLine(strippingNewline: true) {
        do {
            try check(line.utf8.count <= 200000)
            guard let raw = try JSONSerialization.jsonObject(with: Data(line.utf8)) as? [String: Any], let op = raw["op"] as? String else { throw ProtectedFailure() }
            var value: Any = NSNull()
            switch op {
            case "read": guard let name = raw["name"] as? String else { throw ProtectedFailure() }; value = try directory.read(name) as Any? ?? NSNull()
            case "write": guard let name = raw["name"] as? String, let data = raw["data"] as? String else { throw ProtectedFailure() }; try directory.write(name, data: data)
            case "lock": try directory.lock()
            case "unlock": try directory.unlock()
            case "isLocked": value = try directory.isLocked()
            case "confirm":
                guard let origin = raw["origin"] as? String, let email = raw["email"] as? String, origin.count < 2048, email.count < 320 else { throw ProtectedFailure() }
                NSApplication.shared.setActivationPolicy(.accessory); NSApplication.shared.activate(ignoringOtherApps: true)
                let alert = NSAlert(); alert.messageText = "Connect ChatGPT to CollectiveUI?"; alert.informativeText = "Installation: \(origin)\nCollectiveUI account: \(email)\n\nOpenAI will ask you to authorize ChatGPT plan usage separately."; alert.addButton(withTitle: "Continue"); alert.addButton(withTitle: "Cancel"); value = alert.runModal() == .alertFirstButtonReturn
            case "open":
                guard let text = raw["url"] as? String, let url = URL(string: text), url.scheme == "https", url.user == nil, url.password == nil else { throw ProtectedFailure() }; try check(NSWorkspace.shared.open(url))
            default: throw ProtectedFailure()
            }
            emit(["ok": true, "value": value])
        } catch { emit(["ok": false]) }
    }
}
final class Launcher: NSObject, NSApplicationDelegate {
    var running = false
    func application(_ application: NSApplication, open urls: [URL]) {
        guard !running, urls.count == 1 else { return }; running = true
        let resources = Bundle.main.resourceURL!
        let child = Process(); child.executableURL = resources.appendingPathComponent("node"); child.arguments = [resources.appendingPathComponent("companion.mjs").path]
        let input = Pipe(); child.standardInput = input; child.standardOutput = FileHandle.nullDevice; child.standardError = FileHandle.nullDevice
        child.environment = ["PATH": "/usr/bin:/bin", "CUI_COMPANION_HELPER": Bundle.main.executableURL!.path, "CUI_COMPANION_CONFIG": resources.appendingPathComponent("origins.json").path]
        child.terminationHandler = { process in DispatchQueue.main.async {
            if process.terminationStatus != 0 { let alert = NSAlert(); alert.messageText = "ChatGPT connection was not confirmed"; alert.informativeText = "Return to CollectiveUI and check account status before retrying. A pending transfer may need recovery."; alert.addButton(withTitle: "OK"); alert.runModal() }
            NSApplication.shared.terminate(nil)
        } }
        do { try child.run(); input.fileHandleForWriting.write(try JSONSerialization.data(withJSONObject: ["launch": urls[0].absoluteString])); try input.fileHandleForWriting.close() }
        catch { NSApplication.shared.terminate(nil) }
    }
    func applicationDidFinishLaunching(_ notification: Notification) { NSApplication.shared.setActivationPolicy(.accessory) }
}
if CommandLine.arguments.count == 3 && CommandLine.arguments[1] == "--store" {
    do { try storeMain(CommandLine.arguments[2]) } catch { emit(["ok": false]); exit(1) }
} else {
    let application = NSApplication.shared; let delegate = Launcher(); application.delegate = delegate; application.run()
}
