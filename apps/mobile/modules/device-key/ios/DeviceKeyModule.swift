import CryptoKit
import ExpoModulesCore
import LocalAuthentication

/// Expo module exposing the Secure Enclave device key to JavaScript.
///
/// There is deliberately no software fallback: on a device without a Secure Enclave (or in the
/// iOS Simulator, if it reports none) generateKey rejects with ERR_HARDWARE_UNAVAILABLE.
public class DeviceKeyModule: Module {
  public func definition() -> ModuleDefinition {
    Name("DeviceKey")

    AsyncFunction("getCapabilities") { () -> [String: Any] in
      [
        "platform": "ios",
        "hardwareKeyStore": SecureEnclave.isAvailable,
        "strongBox": false,
      ]
    }

    /// Replaces any key under `alias` with a new Secure Enclave key.
    /// Returns { publicKey (base64url DER SPKI), securityLevel, privateKeyExportable, userPresenceRequired }.
    AsyncFunction("generateKey") { (alias: String) -> [String: Any] in
      guard SecureEnclave.isAvailable else {
        throw Self.error("ERR_HARDWARE_UNAVAILABLE", "This device has no Secure Enclave.")
      }
      DeviceKeyCrypto.deleteKey(alias: alias)
      do {
        let key = try DeviceKeyCrypto.generate(
          alias: alias, secureEnclave: true, permanent: true, requireUserPresence: true)
        if DeviceKeyCrypto.isPrivateKeyExportable(key) {
          DeviceKeyCrypto.deleteKey(alias: alias)
          throw Self.error("ERR_KEY_EXPORTABLE", "The platform returned an exportable private key.")
        }
        let spki = try DeviceKeyCrypto.subjectPublicKeyInfo(privateKey: key)
        return [
          "publicKey": DeviceKeyCrypto.base64url(spki),
          "securityLevel": "secure_enclave",
          "privateKeyExportable": false,
          "userPresenceRequired": true,
        ]
      } catch let failure as DeviceKeyCrypto.Failure {
        DeviceKeyCrypto.deleteKey(alias: alias)
        throw Self.map(failure)
      }
    }

    AsyncFunction("hasKey") { (alias: String) -> Bool in
      DeviceKeyCrypto.hasKey(alias: alias)
    }

    AsyncFunction("deleteKey") { (alias: String) in
      DeviceKeyCrypto.deleteKey(alias: alias)
    }

    /// Signs the UTF-8 bytes of `message`. iOS shows Face ID / Touch ID / passcode with `reason`.
    /// Runs off the main thread (the default for AsyncFunction), as SecKeyCreateSignature blocks
    /// while the system prompt is visible.
    AsyncFunction("sign") { (alias: String, message: String, reason: String) -> String in
      let context = LAContext()
      context.localizedReason = reason
      do {
        let key = try DeviceKeyCrypto.loadPrivateKey(alias: alias, context: context)
        let signature = try DeviceKeyCrypto.sign(privateKey: key, message: message)
        return DeviceKeyCrypto.base64url(signature)
      } catch let failure as DeviceKeyCrypto.Failure {
        throw Self.map(failure)
      }
    }
  }

  private static func error(_ code: String, _ description: String) -> Exception {
    Exception(name: "DeviceKeyError", description: description, code: code)
  }

  private static func map(_ failure: DeviceKeyCrypto.Failure) -> Exception {
    switch failure {
    case .noPasscode:
      return error("ERR_NO_PASSCODE", "Set a device passcode to protect the key.")
    case .keyNotFound:
      return error("ERR_KEY_NOT_FOUND", "No device key found. Enroll this phone again.")
    case .userCancelled:
      return error("ERR_USER_CANCELLED", "Authentication was cancelled.")
    case .authFailed(let detail):
      return error("ERR_AUTH_FAILED", detail)
    case .exportFailed:
      return error("ERR_GENERATION_FAILED", "Could not read the new public key.")
    case .generationFailed(let detail):
      return error("ERR_GENERATION_FAILED", detail)
    case .signingFailed(let detail):
      return error("ERR_SIGNING_FAILED", detail)
    }
  }
}
