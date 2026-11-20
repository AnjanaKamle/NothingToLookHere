# Phone app and browser client

The two clients have separate jobs and never share secrets:

|       | Trusted phone (`apps/mobile`)                                                                 | Browser (`apps/web`)                                                        |
| ----- | --------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| Holds | Hardware private key (never leaves the chip); device token in secure storage                  | Nothing readable by JavaScript: session and binding cookies are `HttpOnly`  |
| Does  | Enrolls, scans QR, shows the request, signs approve/reject, manages sessions/phones, recovery | Requests a challenge, shows the QR, waits in real time, completes sign-in   |
| Never | Sends the private key anywhere; stores it in AsyncStorage, files or logs                      | Receives the phone's key; stores credentials in localStorage/sessionStorage |

API calls live in service modules: `apps/mobile/src/services/*`, `apps/web/src/services/*`.
Screens and components never call `fetch` directly.

## Phone app

### Screens and flows

| Screen                        | What it does                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Sign in**                   | Email + password, used once, only to obtain an enrollment challenge. Warns if the build lacks the secure key module (e.g. Expo Go) or the API URL is not configured.                                                                                                                                                                                                                                                                          |
| **Recover account**           | Lost-phone recovery: password + recovery code, optional new password. Explains that every phone and browser will be signed out.                                                                                                                                                                                                                                                                                                               |
| **Secure key** (enroll)       | Names the phone, creates the key in the Secure Enclave / Keystore, signs the enrollment nonce (biometric/passcode prompt), registers the public key, and stores the device token in `expo-secure-store`. The app switches to "trusted" only after the server confirms.                                                                                                                                                                        |
| **Home**                      | Scan button; shows where the key is held (Secure Enclave / StrongBox / TEE), as reported by the platform at creation; links to the other screens.                                                                                                                                                                                                                                                                                             |
| **Scan**                      | Camera with QR-only scanning. Rejects any code not in the exact `capstone-auth:v1:<id>.<nonce>` format without contacting a server. Handles permission states: asking, denied (with "Open Settings"), and granted.                                                                                                                                                                                                                            |
| **Sign-in request** (approve) | Fetches and shows the requester's browser, OS, IP, request time and a live expiry countdown, plus an anti-phishing warning. Approve and Reject each sign the decision for _this_ challenge (biometric/passcode prompt). Shows the server's answer. Handles: cancelled prompt, expired request, invalid signature, phone no longer trusted (offers re-enrollment), and Android key invalidated (offers "Create a new key", i.e. key rotation). |
| **Browsers** (sessions)       | Lists signed-in browsers (browser/OS, IP, signed in, last active, approving phone), with pull to refresh, an empty state, and an error state with retry. Sign out one, after confirmation.                                                                                                                                                                                                                                                    |
| **Phones** (devices)          | Lists trusted phones. Revoke a lost one, or remove this phone (revokes it server-side, deletes the key, clears storage).                                                                                                                                                                                                                                                                                                                      |
| **Recovery**                  | Unused recovery-code count, regenerate codes (shown once, with confirmation), and plain-language lost-phone guidance.                                                                                                                                                                                                                                                                                                                         |

### Platform security support

| Property                            | iOS                                                                                          | Android                                                                                                                                                                      |
| ----------------------------------- | -------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Where the key is generated and used | Secure Enclave                                                                               | StrongBox if present, otherwise TEE (Keystore). The actual level is read from `KeyInfo` and sent to the server as `keyStorage`                                               |
| Non-exportable                      | Yes, by Secure Enclave design; verified after generation                                     | Yes, by Keystore design; verified after generation (`getEncoded()` is `null`)                                                                                                |
| User presence per signature         | `.userPresence`: Face ID, Touch ID or passcode                                               | `setUserAuthenticationParameters(0, BIOMETRIC_STRONG \| DEVICE_CREDENTIAL)` on Android 11+; strong biometric only on Android 7–10                                            |
| Requires a screen lock              | Yes (`WhenPasscodeSetThisDeviceOnly`; the key is destroyed if the passcode is removed)       | Yes (checked with `KeyguardManager.isDeviceSecure`)                                                                                                                          |
| Leaves the device via backup        | No (`ThisDeviceOnly`)                                                                        | No (Keystore keys are never backed up; app backup disabled; secure-store backup rules exclude it)                                                                            |
| Invalidated by biometric changes    | No (`.userPresence` accepts the passcode)                                                    | Yes, Keystore default. The app offers key rotation                                                                                                                           |
| Unsupported hardware                | Refused (`ERR_HARDWARE_UNAVAILABLE`)                                                         | Software-only keys refused, except with `EXPO_PUBLIC_ALLOW_SOFTWARE_KEYS=true` in a development build (emulators); the server records `software` and the app shows a warning |
| Simulator / emulator                | The iOS Simulator may not provide a Secure Enclave; use a physical iPhone                    | Emulators usually report `software`; use a physical phone or the development flag                                                                                            |
| Expo Go                             | Not supported: the native module is missing, so the app shows an error and refuses to enroll | Same                                                                                                                                                                         |

### Verification status

| Check                                                                                                                   | Status                                                                                |
| ----------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| Phone JavaScript bundles for iOS and Android (`npx expo export`)                                                        | Passed                                                                                |
| Autolinking finds `DeviceKey` (iOS pod, Android project)                                                                | Passed                                                                                |
| `expo prebuild` generates Info.plist / manifest entries (camera, Face ID, backup off)                                   | Passed                                                                                |
| `DeviceKeyCrypto.swift` compiles; its SPKI and DER signature verify with the API (`npm run test:native-crypto`)         | Passed (macOS, software key)                                                          |
| Expo-facing Swift module and Kotlin module compile                                                                      | **Not verified**: needs Xcode / Android SDK, not installed on the development machine |
| Secure Enclave / StrongBox / BiometricPrompt behaviour on hardware                                                      | **Not verified**: needs physical devices                                              |
| Phone API contract end to end (`npm run smoke`: same requests and DER signatures as the app, against the running stack) | Passed                                                                                |

Before relying on the app, build it on a real device and walk through
[Manual device test](#manual-device-test) below.

## Browser client

States, all announced to screen readers:

| State                                   | What the user sees                                                                                                               |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Checking session                        | Spinner. If the API is unreachable, an error with "Try again"                                                                    |
| Preparing                               | Spinner while the challenge is requested                                                                                         |
| Waiting                                 | Steps, QR code (encodes only the challenge id and one-time nonce), countdown bar, connection indicator, phishing warning, Cancel |
| Expiring soon                           | At 10 s or less the countdown turns amber; announced once                                                                        |
| Approved → finishing                    | "Approved on your phone. Finishing sign-in…". The page shows "signed in" only after the API returns the session                  |
| Signed in                               | Account, session end time, Sign out. If the phone revokes the session, the page signs out immediately with an explanation        |
| Rejected / Expired / Cancelled / Failed | Clear explanation and "Get a new QR code" (or "Try again")                                                                       |

Reliability:

- Each new QR code is a new attempt. Late events from older codes are ignored.
- When the WebSocket reconnects, the browser re-subscribes and the acknowledgement reports the
  current status. While disconnected it polls the status over HTTP every 3 s. It also checks when
  the tab becomes visible again.
- When the countdown reaches zero, the browser asks the server once more before showing
  "expired", in case an approval landed at the last moment.
- The countdown is corrected for a wrong computer clock using the server's `Date` header.

End-to-end check performed in a browser (with a simulated phone that signs exactly like the native
module: P-256, DER): approve → real-time event → session; `document.cookie`, `localStorage` and
`sessionStorage` all empty; revoke from phone → browser signed out instantly; reject; cancel;
API restarted mid-wait → "Connection lost" → recovered → approved; sign out; code left to expire
→ expiry warning.

## Manual setup

### Browser (any computer on the same machine as the API)

```bash
npm run db:up
```

```bash
npm run dev:api
```

```bash
npm run dev:web
```

Open http://localhost:5173.

### Phone (development build on a physical device)

1. Install the toolchain: Xcode with an iOS device and an Apple developer team for signing, and/or
   Android Studio with platform tools. See
   [Expo: set up your environment](https://docs.expo.dev/get-started/set-up-your-environment/?mode=development-build).
2. Put the phone and computer on the same Wi-Fi network. Find the computer's LAN IP address (macOS:
   `ipconfig getifaddr en0`).
3. Copy `apps/mobile/.env.example` to `apps/mobile/.env` and set
   `EXPO_PUBLIC_API_URL=http://<LAN-IP>:4000`. The API already listens on all interfaces
   (`API_HOST=0.0.0.0`).
4. Give the phone a passcode / screen lock (required for the key).
5. Create an account: `npm run dev:create-user -- --email you@example.test`. Keep the printed
   recovery codes.
6. Build and install the development build (the first time, and after any native change):

```bash
npm run ios --workspace @capstone/mobile -- --device
```

```bash
npm run android --workspace @capstone/mobile -- --device
```

7. Later, start only the bundler: `npm run dev:mobile`.

Plain HTTP over the LAN is for development only. iOS App Transport Security and Android's
cleartext rules block HTTP in release builds. Use HTTPS (e.g. a tunnel or `mkcert`) for anything
beyond local testing (open decision 4 in ARCHITECTURE.md).

### Manual device test

1. Sign in on the phone. Create the key, and confirm the biometric/passcode prompt appears. Home
   shows "Secure Enclave" (iPhone) or "StrongBox"/"Trusted Execution Environment" (Android).
2. Open the browser page and scan. Check the request shows your browser and IP. Approve: the
   prompt appears and the browser signs in.
3. Scan again and reject: the browser shows "Sign-in rejected".
4. Let a code expire before scanning: the phone reports it expired, and so does the browser.
5. "Browsers" lists the session; sign it out and the browser returns to the QR page.
6. Cancel the biometric prompt: nothing is sent, and you can try again.
7. Deny camera permission, then confirm the "Open Settings" path.
8. Android: add a new fingerprint, then try to approve. The app should offer "Create a new key".
