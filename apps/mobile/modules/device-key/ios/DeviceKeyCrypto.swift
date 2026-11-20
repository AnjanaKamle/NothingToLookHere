import Foundation
import LocalAuthentication
import Security

/// Platform crypto for the device key, kept free of ExpoModulesCore so it can be compiled and
/// tested on its own (see modules/device-key/test/).
///
/// Formats match the server (docs/API.md, "Cryptography"):
///  - public key: DER SubjectPublicKeyInfo, uncompressed P-256 point (91 bytes)
///  - signature:  DER ECDSA-Sig-Value from .ecdsaSignatureMessageX962SHA256 (SHA-256 is applied here)
enum DeviceKeyCrypto {
  enum Failure: Error {
    case generationFailed(String)
    case noPasscode
    case keyNotFound
    case exportFailed
    case userCancelled
    case authFailed(String)
    case signingFailed(String)
  }

  /// ASN.1 prefix of a P-256 SubjectPublicKeyInfo: SEQUENCE { SEQUENCE { id-ecPublicKey,
  /// prime256v1 }, BIT STRING (0 unused bits) ... } followed by the 65-byte X9.63 point.
  static let p256SpkiHeader: [UInt8] = [
    0x30, 0x59, 0x30, 0x13, 0x06, 0x07, 0x2A, 0x86, 0x48, 0xCE, 0x3D, 0x02, 0x01, 0x06, 0x08,
    0x2A, 0x86, 0x48, 0xCE, 0x3D, 0x03, 0x01, 0x07, 0x03, 0x42, 0x00,
  ]

  static func applicationTag(_ alias: String) -> Data {
    Data("dev.capstone.trustedphone.devicekey.\(alias)".utf8)
  }

  /// Creates a P-256 key pair.
  /// - secureEnclave: generate inside the Secure Enclave (non-exportable by construction).
  /// - permanent: store in the keychain under the alias (false only for tests).
  /// - requireUserPresence: every signature needs Face ID / Touch ID / device passcode.
  static func generate(
    alias: String, secureEnclave: Bool, permanent: Bool, requireUserPresence: Bool
  ) throws -> SecKey {
    var privateAttributes: [String: Any] = [kSecAttrIsPermanent as String: permanent]
    if permanent {
      privateAttributes[kSecAttrApplicationTag as String] = applicationTag(alias)
      var flags: SecAccessControlCreateFlags = []
      if secureEnclave { flags.insert(.privateKeyUsage) }
      if requireUserPresence { flags.insert(.userPresence) }
      var error: Unmanaged<CFError>?
      // WhenPasscodeSetThisDeviceOnly: never leaves this device (no backup/migration), and the
      // key is destroyed if the user removes their passcode.
      guard
        let access = SecAccessControlCreateWithFlags(
          kCFAllocatorDefault, kSecAttrAccessibleWhenPasscodeSetThisDeviceOnly, flags, &error)
      else {
        throw Failure.generationFailed(describe(error))
      }
      privateAttributes[kSecAttrAccessControl as String] = access
    }

    var attributes: [String: Any] = [
      kSecAttrKeyType as String: kSecAttrKeyTypeECSECPrimeRandom,
      kSecAttrKeySizeInBits as String: 256,
      kSecPrivateKeyAttrs as String: privateAttributes,
    ]
    if secureEnclave {
      attributes[kSecAttrTokenID as String] = kSecAttrTokenIDSecureEnclave
    }

    var error: Unmanaged<CFError>?
    guard let key = SecKeyCreateRandomKey(attributes as CFDictionary, &error) else {
      let nsError = error?.takeRetainedValue() as Error? as NSError?
      if nsError?.code == Int(errSecAuthFailed) || nsError?.code == LAError.passcodeNotSet.rawValue {
        throw Failure.noPasscode
      }
      throw Failure.generationFailed(nsError?.localizedDescription ?? "unknown error")
    }
    return key
  }

  /// Looks up the stored private key. The reference itself is not secret: using it to sign is
  /// what requires user presence. `context` carries the prompt text shown to the user.
  static func loadPrivateKey(alias: String, context: LAContext? = nil) throws -> SecKey {
    var query: [String: Any] = [
      kSecClass as String: kSecClassKey,
      kSecAttrApplicationTag as String: applicationTag(alias),
      kSecAttrKeyType as String: kSecAttrKeyTypeECSECPrimeRandom,
      kSecAttrKeyClass as String: kSecAttrKeyClassPrivate,
      kSecReturnRef as String: true,
    ]
    if let context { query[kSecUseAuthenticationContext as String] = context }
    var item: CFTypeRef?
    let status = SecItemCopyMatching(query as CFDictionary, &item)
    guard status == errSecSuccess, let item else { throw Failure.keyNotFound }
    return item as! SecKey  // swiftlint:disable:this force_cast — CF type, cast cannot fail
  }

  static func hasKey(alias: String) -> Bool {
    let context = LAContext()
    context.interactionNotAllowed = true
    return (try? loadPrivateKey(alias: alias, context: context)) != nil
  }

  static func deleteKey(alias: String) {
    let query: [String: Any] = [
      kSecClass as String: kSecClassKey,
      kSecAttrApplicationTag as String: applicationTag(alias),
    ]
    SecItemDelete(query as CFDictionary)
  }

  /// DER SubjectPublicKeyInfo for the key pair's public half.
  static func subjectPublicKeyInfo(privateKey: SecKey) throws -> Data {
    var error: Unmanaged<CFError>?
    guard let publicKey = SecKeyCopyPublicKey(privateKey),
      let point = SecKeyCopyExternalRepresentation(publicKey, &error) as Data?,
      point.count == 65, point.first == 0x04
    else {
      throw Failure.exportFailed
    }
    return Data(p256SpkiHeader) + point
  }

  /// True if the platform would hand out the private key bytes. For Secure Enclave keys this is
  /// always false; the module refuses any key for which it is true.
  static func isPrivateKeyExportable(_ privateKey: SecKey) -> Bool {
    var error: Unmanaged<CFError>?
    let exported = SecKeyCopyExternalRepresentation(privateKey, &error)
    return exported != nil
  }

  /// ECDSA P-256 / SHA-256 signature over the UTF-8 bytes of `message`, DER encoded.
  static func sign(privateKey: SecKey, message: String) throws -> Data {
    var error: Unmanaged<CFError>?
    guard
      let signature = SecKeyCreateSignature(
        privateKey, .ecdsaSignatureMessageX962SHA256, Data(message.utf8) as CFData, &error)
        as Data?
    else {
      let nsError = error?.takeRetainedValue() as Error? as NSError?
      switch nsError?.code {
      case Int(errSecUserCanceled), LAError.userCancel.rawValue, LAError.systemCancel.rawValue,
        LAError.appCancel.rawValue:
        throw Failure.userCancelled
      case Int(errSecAuthFailed), LAError.authenticationFailed.rawValue,
        LAError.biometryLockout.rawValue:
        throw Failure.authFailed(nsError?.localizedDescription ?? "authentication failed")
      default:
        throw Failure.signingFailed(nsError?.localizedDescription ?? "unknown error")
      }
    }
    return signature
  }

  static func base64url(_ data: Data) -> String {
    data.base64EncodedString()
      .replacingOccurrences(of: "+", with: "-")
      .replacingOccurrences(of: "/", with: "_")
      .replacingOccurrences(of: "=", with: "")
  }

  private static func describe(_ error: Unmanaged<CFError>?) -> String {
    (error?.takeRetainedValue() as Error?)?.localizedDescription ?? "unknown error"
  }
}
