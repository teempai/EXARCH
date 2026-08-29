import Foundation
import ExarchFoundation

let arguments = CommandLine.arguments
guard arguments.count == 3 else {
    FileHandle.standardError.write(Data("Usage: exarch-keychain put|get|delete ACCOUNT\n".utf8))
    exit(64)
}

let command = arguments[1]
let account = arguments[2]
guard account.range(of: #"^[A-Za-z0-9._-]{1,200}$"#, options: .regularExpression) != nil else {
    FileHandle.standardError.write(Data("Invalid Keychain account\n".utf8))
    exit(64)
}

let store = KeychainStore(
    service: "com.teempai.exarch.daemon",
    legacyServices: ["com.teempai.mobile-remote-agent.daemon"]
)
do {
    switch command {
    case "put":
        let value = FileHandle.standardInput.readDataToEndOfFile()
        guard !value.isEmpty, value.count <= 8 * 1024 else { throw ExarchError.invalidEncoding }
        try store.write(value, account: account)
    case "get":
        guard let value = try store.read(account: account), value.count <= 8 * 1024 else {
            throw ExarchError.unavailable("Keychain item is missing")
        }
        FileHandle.standardOutput.write(value)
    case "delete":
        try store.delete(account: account)
    default:
        throw ExarchError.invalidPayload("Unknown Keychain command")
    }
} catch {
    FileHandle.standardError.write(Data("Keychain operation failed\n".utf8))
    exit(1)
}
