package expo.modules.devicekey

import android.app.KeyguardManager
import android.content.pm.PackageManager
import android.os.Build
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyInfo
import android.security.keystore.KeyPermanentlyInvalidatedException
import android.security.keystore.KeyProperties
import android.security.keystore.StrongBoxUnavailableException
import android.util.Base64
import androidx.biometric.BiometricManager.Authenticators.BIOMETRIC_STRONG
import androidx.biometric.BiometricManager.Authenticators.DEVICE_CREDENTIAL
import androidx.biometric.BiometricPrompt
import androidx.core.content.ContextCompat
import androidx.fragment.app.FragmentActivity
import expo.modules.kotlin.Promise
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.functions.Queues
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.security.KeyFactory
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.PrivateKey
import java.security.Signature
import java.security.spec.ECGenParameterSpec

/**
 * Expo module exposing an Android Keystore device key to JavaScript.
 *
 * Key: EC P-256 (secp256r1), PURPOSE_SIGN only, SHA-256, StrongBox when the device has it and
 * the TEE otherwise. Keystore private keys are never exportable (PrivateKey.getEncoded() returns
 * null); generateKey checks this and refuses otherwise. Each signature requires user
 * authentication (strong biometric or device credential), enforced by the Keystore itself.
 * The actual security level (strongbox / tee / software) is read back from KeyInfo and returned,
 * so the app and server can apply policy. There is no in-app software fallback.
 */
class DeviceKeyModule : Module() {
  private val keyStore: KeyStore
    get() = KeyStore.getInstance(ANDROID_KEYSTORE).apply { load(null) }

  private val context
    get() = appContext.reactContext ?: throw CodedException("ERR_NO_ACTIVITY", "React context unavailable", null)

  override fun definition() = ModuleDefinition {
    Name("DeviceKey")

    AsyncFunction("getCapabilities") {
      mapOf(
        "platform" to "android",
        "hardwareKeyStore" to true,
        "strongBox" to (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P &&
          context.packageManager.hasSystemFeature(PackageManager.FEATURE_STRONGBOX_KEYSTORE)),
      )
    }

    AsyncFunction("generateKey") { alias: String -> generateKey(alias) }

    AsyncFunction("hasKey") { alias: String -> keyStore.containsAlias(alias) }

    AsyncFunction("deleteKey") { alias: String ->
      val store = keyStore
      if (store.containsAlias(alias)) store.deleteEntry(alias)
    }

    // BiometricPrompt must be created and shown on the main thread.
    AsyncFunction("sign") { alias: String, message: String, reason: String, promise: Promise ->
      sign(alias, message, reason, promise)
    }.runOnQueue(Queues.MAIN)
  }

  private fun generateKey(alias: String): Map<String, Any> {
    val keyguard = context.getSystemService(KeyguardManager::class.java)
    if (keyguard == null || !keyguard.isDeviceSecure) {
      throw CodedException("ERR_NO_PASSCODE", "Set a screen lock to protect the key.", null)
    }

    val store = keyStore
    if (store.containsAlias(alias)) store.deleteEntry(alias)

    val generator = KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_EC, ANDROID_KEYSTORE)
    val pair = try {
      generator.initialize(spec(alias, strongBox = true))
      generator.generateKeyPair()
    } catch (e: StrongBoxUnavailableException) {
      generator.initialize(spec(alias, strongBox = false))
      generator.generateKeyPair()
    } catch (e: Exception) {
      throw CodedException("ERR_GENERATION_FAILED", e.message ?: "Key generation failed", e)
    }

    if (pair.private.encoded != null) {
      store.deleteEntry(alias)
      throw CodedException("ERR_KEY_EXPORTABLE", "The platform returned an exportable private key.", null)
    }

    return mapOf(
      "publicKey" to base64url(pair.public.encoded), // X.509 SubjectPublicKeyInfo, DER
      "securityLevel" to securityLevel(pair.private),
      "privateKeyExportable" to false,
      "userPresenceRequired" to true,
    )
  }

  private fun spec(alias: String, strongBox: Boolean): KeyGenParameterSpec {
    val builder = KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_SIGN)
      .setAlgorithmParameterSpec(ECGenParameterSpec("secp256r1"))
      .setDigests(KeyProperties.DIGEST_SHA256)
      .setUserAuthenticationRequired(true)
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
      // 0 seconds = authentication required for every single use.
      builder.setUserAuthenticationParameters(
        0,
        KeyProperties.AUTH_BIOMETRIC_STRONG or KeyProperties.AUTH_DEVICE_CREDENTIAL,
      )
    }
    if (strongBox && Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
      builder.setIsStrongBoxBacked(true)
    }
    return builder.build()
  }

  private fun securityLevel(privateKey: PrivateKey): String {
    val info = KeyFactory.getInstance(privateKey.algorithm, ANDROID_KEYSTORE)
      .getKeySpec(privateKey, KeyInfo::class.java)
    return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
      when (info.securityLevel) {
        KeyProperties.SECURITY_LEVEL_STRONGBOX -> "strongbox"
        KeyProperties.SECURITY_LEVEL_TRUSTED_ENVIRONMENT -> "tee"
        KeyProperties.SECURITY_LEVEL_SOFTWARE -> "software"
        else -> "unknown"
      }
    } else {
      @Suppress("DEPRECATION")
      if (info.isInsideSecureHardware) "tee" else "software"
    }
  }

  private fun sign(alias: String, message: String, reason: String, promise: Promise) {
    val activity = appContext.currentActivity as? FragmentActivity
      ?: return promise.reject("ERR_NO_ACTIVITY", "No foreground activity to show the prompt", null)

    val privateKey = try {
      keyStore.getKey(alias, null) as? PrivateKey
    } catch (e: Exception) {
      null
    } ?: return promise.reject("ERR_KEY_NOT_FOUND", "No device key found. Enroll this phone again.", null)

    val signature = Signature.getInstance("SHA256withECDSA")
    try {
      signature.initSign(privateKey)
    } catch (e: KeyPermanentlyInvalidatedException) {
      return promise.reject("ERR_KEY_INVALIDATED", "The device key was invalidated by a security change.", e)
    } catch (e: Exception) {
      return promise.reject("ERR_SIGNING_FAILED", e.message ?: "Could not use the device key", e)
    }

    val callback = object : BiometricPrompt.AuthenticationCallback() {
      override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) {
        try {
          val unlocked = result.cryptoObject?.signature
            ?: return promise.reject("ERR_SIGNING_FAILED", "Prompt returned no signature object", null)
          unlocked.update(message.toByteArray(Charsets.UTF_8))
          promise.resolve(base64url(unlocked.sign())) // DER ECDSA-Sig-Value
        } catch (e: Exception) {
          promise.reject("ERR_SIGNING_FAILED", e.message ?: "Signing failed", e)
        }
      }

      override fun onAuthenticationError(errorCode: Int, errString: CharSequence) {
        val cancelled = errorCode == BiometricPrompt.ERROR_USER_CANCELED ||
          errorCode == BiometricPrompt.ERROR_NEGATIVE_BUTTON ||
          errorCode == BiometricPrompt.ERROR_CANCELED
        if (cancelled) {
          promise.reject("ERR_USER_CANCELLED", "Authentication was cancelled.", null)
        } else {
          promise.reject("ERR_AUTH_FAILED", errString.toString(), null)
        }
      }

      // A non-matching fingerprint: the prompt stays open for another try. Nothing to do.
      override fun onAuthenticationFailed() {}
    }

    val promptInfo = BiometricPrompt.PromptInfo.Builder()
      .setTitle("Confirm it's you")
      .setSubtitle(reason)
      .apply {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
          setAllowedAuthenticators(BIOMETRIC_STRONG or DEVICE_CREDENTIAL)
        } else {
          // Before Android 11, keys bound to per-use auth can only be unlocked by biometrics.
          setAllowedAuthenticators(BIOMETRIC_STRONG)
          setNegativeButtonText("Cancel")
        }
      }
      .build()

    BiometricPrompt(activity, ContextCompat.getMainExecutor(activity), callback)
      .authenticate(promptInfo, BiometricPrompt.CryptoObject(signature))
  }

  private fun base64url(bytes: ByteArray): String =
    Base64.encodeToString(bytes, Base64.URL_SAFE or Base64.NO_WRAP or Base64.NO_PADDING)

  companion object {
    private const val ANDROID_KEYSTORE = "AndroidKeyStore"
  }
}
