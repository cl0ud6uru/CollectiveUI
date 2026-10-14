# CollectiveUI ChatGPT Mac companion

Review build (uses the repository's installed Node runtime and dependencies):

```sh
node --import tsx scripts/build-chatgpt-companion.mts --origin https://your-exact-collectiveui-origin
```

The build writes only `build/CollectiveUI ChatGPT.app` and a worktree Swift module cache. It packages the current Node executable, bundled client code, a native AppKit launcher/storage helper, and an exact origin allowlist. It compiles and checks the plist without launching or registering the application.

The resulting bundle is an unsigned review artifact. Distribution requires approved release signing/notarization and one-time user installation. No certificates, Keychain access, signing, installation, or LaunchServices registration occur in this build script.

At runtime, the native application accepts only the fixed `collectiveui-chatgpt://connect` launch shape. Its client verifies the packaged HTTPS origin, redeems the owner-bound capability, and asks the user to confirm the installation origin and CollectiveUI account email before opening OpenAI's official sign-in page. Tokens never enter launch arguments or browser return URLs.

Protected state lives in the user's `Library/Application Support/CollectiveUI ChatGPT` directory only when the installed application runs. The helper walks paths with descriptor-relative `openat`, refuses symlinks, verifies file ownership and permissions, writes atomically, syncs files/directories, and uses a kernel-released exclusive lock. Separate attempt directories prevent custody journals from colliding.

After source custody suspension, this client exposes recovery rather than local refresh. Lost delivery replies are resolved through authenticated signed recovery; only a signed pending acknowledgement permits retrying that exact suspended snapshot. A complete acknowledgement removes local credential material. Browser navigation returns only to the installation's fixed connected-accounts settings page.

The server implements `/api/chatgpt/companion` redemption, scoped native authentication, cancellation, and the signed challenge/receive/recover contract. See the [installation and protocol documentation](../../docs/chatgpt-companion.md). Receiver pairing digests must use exactly `{pairingId, ownerId, sourceHostId, sourceSigningPublicKey, approvedUntil}`. Fresh authorization expires after ten minutes; protected suspended recovery remains limited by the pairing's approved recovery window.
