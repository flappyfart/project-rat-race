import Foundation
import Security

// Dedicated operator helper. Secret input/output is only used over child-process pipes.
// Never run `read` directly in a terminal transcript. The website does not import this helper.
let service = "com.projectratrace.treasury"
let account = "robinhood-eth-experiment"
let mode = CommandLine.arguments.count == 2 ? CommandLine.arguments[1] : ""
let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: account]
func fail(_ status: OSStatus) -> Never {
    FileHandle.standardError.write(Data("keychain operation failed: \(status)\n".utf8))
    exit(1)
}
if mode == "probe" {
    var result: CFTypeRef?
    let status = SecItemCopyMatching(query as CFDictionary, &result)
    if status == errSecSuccess { print("present") }
    else if status == errSecItemNotFound { print("absent") }
    else { fail(status) }
} else if mode == "create" {
    let data = FileHandle.standardInput.readDataToEndOfFile()
    guard data.count > 64 && data.count < 4096 else { fail(errSecParam) }
    var attributes = query
    attributes[kSecValueData as String] = data
    attributes[kSecAttrLabel as String] = "project rat race experiment treasury"
    attributes[kSecAttrDescription as String] = "dedicated operator custody. not accessible through the rat website."
    let status = SecItemAdd(attributes as CFDictionary, nil)
    if status != errSecSuccess { fail(status) }
    print("stored")
} else if mode == "read" {
    var attributes = query
    attributes[kSecReturnData as String] = true
    attributes[kSecMatchLimit as String] = kSecMatchLimitOne
    var result: CFTypeRef?
    let status = SecItemCopyMatching(attributes as CFDictionary, &result)
    if status != errSecSuccess { fail(status) }
    guard let data = result as? Data else { fail(errSecDecode) }
    FileHandle.standardOutput.write(data)
} else {
    FileHandle.standardError.write(Data("valid mode required\n".utf8))
    exit(2)
}
