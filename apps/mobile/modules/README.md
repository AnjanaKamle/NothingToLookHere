# Local native modules

Local [Expo modules](https://docs.expo.dev/modules/get-started/) (Swift + Kotlin), autolinked
from this folder.

## `device-key`

Hardware-backed, non-exportable ES256 key for the trusted phone. JavaScript never sees the
private key: it receives the public key (DER SPKI, base64url) and signatures (DER, base64url).

| Function                            | iOS (`ios/DeviceKeyModule.swift`, `DeviceKeyCrypto.swift`)                                                                                                      | Android (`android/.../DeviceKeyModule.kt`)                                                                                   |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `generateKey(alias)`                | P-256 key created **inside the Secure Enclave** (`kSecAttrTokenIDSecureEnclave`); access `WhenPasscodeSetThisDeviceOnly` + `.privateKeyUsage` + `.userPresence` | EC P-256 in **Android Keystore**, StrongBox if present, else TEE; `PURPOSE_SIGN`, SHA-256, user authentication for every use |
| returns                             | `{ publicKey, securityLevel: "secure_enclave", privateKeyExportable: false, userPresenceRequired: true }`                                                       | `{ publicKey, securityLevel: "strongbox" \| "tee" \| "software", privateKeyExportable: false, userPresenceRequired: true }`  |
| `sign(alias, message, reason)`      | `SecKeyCreateSignature(.ecdsaSignatureMessageX962SHA256)` after Face ID / Touch ID / passcode                                                                   | `Signature("SHA256withECDSA")` unlocked by `BiometricPrompt` with a `CryptoObject` (strong biometric or device credential)   |
| `hasKey(alias)`, `deleteKey(alias)` | Keychain lookup / delete by application tag                                                                                                                     | `KeyStore.containsAlias` / `deleteEntry`                                                                                     |
| `getCapabilities()`                 | `SecureEnclave.isAvailable`                                                                                                                                     | StrongBox feature flag                                                                                                       |

**Non-exportable, checked at runtime.** After generating a key, both implementations try to read
the private key bytes (`SecKeyCopyExternalRepresentation` on iOS, `PrivateKey.getEncoded()` on
Android). If that succeeds, they delete the key and fail with `ERR_KEY_EXPORTABLE`.

**No silent fallback.** Without a Secure Enclave, iOS rejects with `ERR_HARDWARE_UNAVAILABLE`.
On Android the actual security level is read back from `KeyInfo`, and the app refuses
`software` keys unless `EXPO_PUBLIC_ALLOW_SOFTWARE_KEYS=true` in a development build (for
emulators). Without a screen lock, both platforms reject with `ERR_NO_PASSCODE`.

Error codes are listed in [device-key/index.js](device-key/index.js).

### Testing

- `npm run test:native-crypto --workspace @capstone/mobile` (macOS): compiles
  `DeviceKeyCrypto.swift` with the Command Line Tools, signs the protocol message with a
  software key, and verifies the public key and DER signature with the API's own verifier.
  This covers the encoding code, not the Secure Enclave itself.
- The Expo-facing Swift and the Kotlin code need Xcode / Android Studio to compile, and the
  hardware paths need a physical device. See [docs/CLIENTS.md](../../../docs/CLIENTS.md).

Custom native code means the app **cannot run in Expo Go**: it needs a development build.
