import Foundation
import Security

protocol CredentialStore {
    func set(_ value: String, for account: String)
    func string(for account: String) -> String?
    func remove(_ account: String)
}

struct KeychainCredentials: CredentialStore {
    func set(_ value: String, for account: String) { KeychainStore.set(value, for: account) }
    func string(for account: String) -> String? { KeychainStore.string(for: account) }
    func remove(_ account: String) { KeychainStore.remove(account) }
}

/// Device-local generic passwords. iOS uses after-first-unlock protection; macOS uses the login Keychain.
enum KeychainStore {
    #if os(macOS)
    private static var service: String { Bundle.main.bundleIdentifier ?? "io.collectiveui.macos" }
    #else
    private static let service = "io.collectiveui.app"
    #endif

    static func set(_ value: String, for account: String) {
        let base: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
        _ = SecItemDelete(base as CFDictionary)
        var attributes = base
        attributes[kSecValueData as String] = Data(value.utf8)
        #if os(iOS)
        attributes[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        #endif
        attributes[kSecAttrSynchronizable as String] = false
        _ = SecItemAdd(attributes as CFDictionary, nil)
    }

    static func string(for account: String) -> String? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        var result: AnyObject?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        guard status == errSecSuccess, let data = result as? Data else {
            return nil
        }
        return String(data: data, encoding: .utf8)
    }

    static func remove(_ account: String) {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
        _ = SecItemDelete(query as CFDictionary)
    }
}
