import Foundation
import Security

/// Serializes credential-store test harnesses that mutate process-wide seams.
enum CredentialStoreTestIsolation {
    static let lock = NSLock()
}

/// Narrow CodeBurn-owned Keychain cache over exact service/account pairs.
///
/// Production uses `LiveKeychainCredentialCache`. Tests inject
/// `InMemoryKeychainCredentialCache` so the suite never touches the login
/// Keychain. Errors carry only operation, service, and OSStatus — never blob data.
protocol KeychainCredentialCaching: Sendable {
    func read(service: String, account: String) throws -> Data?
    func upsert(service: String, account: String, data: Data) throws
    func delete(service: String, account: String) throws
}

enum KeychainCredentialCacheError: Error, LocalizedError, Equatable {
    case readFailed(service: String, status: OSStatus)
    case writeFailed(service: String, status: OSStatus)
    case deleteFailed(service: String, status: OSStatus)

    var errorDescription: String? {
        switch self {
        case let .readFailed(service, status):
            return "Keychain read failed for \(service) (status \(status))."
        case let .writeFailed(service, status):
            return "Keychain write failed for \(service) (status \(status))."
        case let .deleteFailed(service, status):
            return "Keychain delete failed for \(service) (status \(status))."
        }
    }
}

/// Published CodeBurn Keychain identities. Keep these exact — Electron contracts
/// on the Codex pair, and historical items use the same names.
enum CodeBurnKeychainIdentity {
    static let claudeService = "org.agentseal.codeburn.menubar.claude.oauth.v1"
    static let codexService = "org.agentseal.codeburn.menubar.codex.oauth.v1"
    static let account = "default"
}

struct LiveKeychainCredentialCache: KeychainCredentialCaching {
    func read(service: String, account: String) throws -> Data? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecMatchLimit as String: kSecMatchLimitOne,
            kSecReturnData as String: true,
        ]
        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let data = result as? Data else {
            throw KeychainCredentialCacheError.readFailed(service: service, status: status)
        }
        return data
    }

    func upsert(service: String, account: String, data: Data) throws {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
        let attributes: [String: Any] = [
            kSecValueData as String: data,
        ]
        let updateStatus = SecItemUpdate(query as CFDictionary, attributes as CFDictionary)
        if updateStatus == errSecSuccess { return }
        if updateStatus == errSecItemNotFound {
            var add = query
            add[kSecValueData as String] = data
            let addStatus = SecItemAdd(add as CFDictionary, nil)
            if addStatus == errSecSuccess { return }
            if addStatus == errSecDuplicateItem {
                let retry = SecItemUpdate(query as CFDictionary, attributes as CFDictionary)
                guard retry == errSecSuccess else {
                    throw KeychainCredentialCacheError.writeFailed(service: service, status: retry)
                }
                return
            }
            throw KeychainCredentialCacheError.writeFailed(service: service, status: addStatus)
        }
        throw KeychainCredentialCacheError.writeFailed(service: service, status: updateStatus)
    }

    func delete(service: String, account: String) throws {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
        let status = SecItemDelete(query as CFDictionary)
        if status == errSecSuccess || status == errSecItemNotFound { return }
        throw KeychainCredentialCacheError.deleteFailed(service: service, status: status)
    }
}

/// Process-local fake for tests. Never writes to the system Keychain.
final class InMemoryKeychainCredentialCache: KeychainCredentialCaching, @unchecked Sendable {
    private let lock = NSLock()
    private var items: [String: Data] = [:]
    private(set) var upsertCount = 0
    private(set) var readCount = 0
    private(set) var deleteCount = 0

    private func key(_ service: String, _ account: String) -> String {
        "\(service)\u{1f}\(account)"
    }

    func read(service: String, account: String) throws -> Data? {
        lock.lock(); defer { lock.unlock() }
        readCount += 1
        return items[key(service, account)]
    }

    func upsert(service: String, account: String, data: Data) throws {
        lock.lock(); defer { lock.unlock() }
        upsertCount += 1
        items[key(service, account)] = data
    }

    func delete(service: String, account: String) throws {
        lock.lock(); defer { lock.unlock() }
        deleteCount += 1
        items.removeValue(forKey: key(service, account))
    }

    func storedJSONObject(service: String, account: String) -> [String: Any]? {
        lock.lock(); defer { lock.unlock() }
        guard let data = items[key(service, account)] else { return nil }
        return (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
    }

    func storedKeys(service: String, account: String) -> [String]? {
        storedJSONObject(service: service, account: account).map { Array($0.keys).sorted() }
    }

    /// Snapshot for simulated process restart: keep Keychain bytes, drop nothing else.
    func cloneStorage() -> InMemoryKeychainCredentialCache {
        lock.lock(); defer { lock.unlock() }
        let copy = InMemoryKeychainCredentialCache()
        copy.items = items
        return copy
    }
}

/// Test double that wraps another backend and can force upsert/read/delete failures.
final class ControllableKeychainCredentialCache: KeychainCredentialCaching, @unchecked Sendable {
    private let inner: any KeychainCredentialCaching
    var failUpsert = false
    var failRead = false
    var failDelete = false
    var upsertStatus: OSStatus = -1
    var readStatus: OSStatus = -1
    var deleteStatus: OSStatus = -1

    init(inner: any KeychainCredentialCaching) {
        self.inner = inner
    }

    func read(service: String, account: String) throws -> Data? {
        if failRead {
            throw KeychainCredentialCacheError.readFailed(service: service, status: readStatus)
        }
        return try inner.read(service: service, account: account)
    }

    func upsert(service: String, account: String, data: Data) throws {
        if failUpsert {
            throw KeychainCredentialCacheError.writeFailed(service: service, status: upsertStatus)
        }
        try inner.upsert(service: service, account: account, data: data)
    }

    func delete(service: String, account: String) throws {
        if failDelete {
            throw KeychainCredentialCacheError.deleteFailed(service: service, status: deleteStatus)
        }
        try inner.delete(service: service, account: account)
    }
}
