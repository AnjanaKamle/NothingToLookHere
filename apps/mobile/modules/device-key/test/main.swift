// Test harness for DeviceKeyCrypto.swift on macOS (no Secure Enclave entitlement needed).
// Uses a non-permanent software key, which exercises the same SPKI-encoding and signing code
// paths as the Secure Enclave key, and prints JSON for the Node verifier (verify.mjs).
import Foundation

let message = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "hello"
do {
  let key = try DeviceKeyCrypto.generate(
    alias: "test", secureEnclave: false, permanent: false, requireUserPresence: false)
  let spki = try DeviceKeyCrypto.subjectPublicKeyInfo(privateKey: key)
  let signature = try DeviceKeyCrypto.sign(privateKey: key, message: message)
  let output: [String: Any] = [
    "publicKey": DeviceKeyCrypto.base64url(spki),
    "publicKeyLength": spki.count,
    "signature": DeviceKeyCrypto.base64url(signature),
    // A software key IS exportable; the module refuses such keys. Reported to prove the check works.
    "softwareKeyReportedExportable": DeviceKeyCrypto.isPrivateKeyExportable(key),
  ]
  let json = try JSONSerialization.data(withJSONObject: output)
  print(String(data: json, encoding: .utf8)!)
} catch {
  FileHandle.standardError.write(Data("error: \(error)\n".utf8))
  exit(1)
}
