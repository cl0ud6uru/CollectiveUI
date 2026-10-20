import Foundation
import CryptoKit

/// Proof Key for Code Exchange (RFC 7636) helpers, S256 method only.
public enum PKCE {
    /// A 43-character code verifier: base64url of 32 random bytes.
    public static func makeVerifier() -> String {
        return base64URLEncode(randomBytes(count: 32))
    }

    /// base64url(SHA256(verifier)) without padding.
    public static func challenge(for verifier: String) -> String {
        let digest = SHA256.hash(data: Data(verifier.utf8))
        return base64URLEncode(Data(digest))
    }

    /// Random opaque value used to bind the callback to this request.
    public static func makeState() -> String {
        return base64URLEncode(randomBytes(count: 16))
    }

    public static func base64URLEncode(_ data: Data) -> String {
        return data.base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }

    static func randomBytes(count: Int) -> Data {
        var bytes = [UInt8]()
        bytes.reserveCapacity(count)
        for _ in 0..<count {
            bytes.append(UInt8.random(in: UInt8.min...UInt8.max))
        }
        return Data(bytes)
    }
}
