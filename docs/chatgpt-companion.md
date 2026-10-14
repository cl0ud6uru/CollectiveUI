# ChatGPT sign-in companion

This optional Mac application completes OpenAI authorization on the user's computer, then transfers the protected grant to their existing CollectiveUI account. The native harness and stock Codex use the same stored credential. The website never receives tokens or an OpenAI callback. Installation is required once; subsequent sign-ins start in Settings → Connected accounts.

The implementation follows OpenAI's [open-source local sign-in flow](https://developers.openai.com/siwc/token-sharing-open-source/sign-in) and [self-hosted VM transfer guidance](https://developers.openai.com/siwc/token-sharing-open-source/self-hosted-vms). Dynamic registration returns an account-specific client ID. Returning grants retain that registration and subject. OAuth uses fresh state, nonce, PKCE and a bound `127.0.0.1` listener before opening the browser.

## Operator prerequisites

1. Apply migration `0057_chatgpt_companion` through the normal reviewed migration process. It adds one table; workspace and account records are preserved.
2. Keep the installation's existing `CHATGPT_SIWC_HOST_ID`, encryption keyring and HTTPS `AUTH_URL`. The Mac generates a different stable local host ID.
3. Build for the installation's exact origin from the reviewed checkout:

   ```sh
   node --import tsx scripts/build-chatgpt-companion.mts --origin https://your-installation.example
   ```

   The output is `build/CollectiveUI ChatGPT.app`. This command compiles, bundles the current Node executable and validates the plist. It does not launch, install, register, sign or notarize the application. Build separately for each supported Mac architecture with a release-supported Node runtime. Keep the origin allowlist exact.
4. Release the reviewed application through the operator's Mac distribution process, including Developer ID signing, hardened runtime, notarization, stapling and verification. The unsigned build is a review artifact. The exact signing commands depend on the operator's certificate, runtime entitlements and distribution packaging; this PR neither accesses those credentials nor claims distribution acceptance.
5. Host the approved download at an HTTPS URL and configure `CHATGPT_COMPANION_DOWNLOAD_URL`. Set `CHATGPT_COMPANION_ENABLED=true` only after distribution review. Until then, the existing protected CLI import remains available and the new feature is disabled.
6. Explicitly enable ChatGPT access for intended users/groups and personal plans in Admin. A legacy workspace allowlist remains blocking because SIWC does not expose that metadata. Stock Codex additionally requires the already-reviewed private broker/runtime configuration and owner consent.

No additional OpenAI partner client approval is required by the open-source dynamic registration flow. Public Mac distribution does require the operator's release identity and approval. Live provider acceptance remains a separate authorized validation.

## User flow

Install the approved application. In Settings → Connected accounts, review storage/custody consent and select whether to prepare stock Codex, then click Sign in with ChatGPT and open the local application. The application confirms the installation origin and CollectiveUI email before opening OpenAI. Sign in with the matching ChatGPT account. After transfer completes, return to Settings; current backend status determines whether the account is connected. A Codex synchronization failure leaves the native account available and can be retried without another sign-in.

Cancel before custody closes the paired server attempt and clears any pre-custody local grant after attempting revocation. Browser Cancel, account disconnect, bulk disconnect and user disable fence pending attempts. A canceled or expired launch cannot begin another OAuth flow; create a new attempt explicitly.

## Custody and recovery

Fresh authorization expires after ten minutes. Signed recovery remains bounded to one day. The server encrypts receiver keys and return capability with row-and-owner-bound AAD. The launch capability is hashed and is never placed in browser storage or the DOM. Native transport rejects browser Origin, Cookie and Fetch Metadata headers and supplies no CORS access.

The source durably suspends refresh before sending an Ed25519-authenticated, X25519/AES-GCM-encrypted snapshot. Only the VM subsequently refreshes it. A complete signed receipt removes local credential material. A lost response triggers signed recovery; only a signed pending receipt permits retrying the exact suspended envelope. A negative receipt fences any delayed server activation before it is returned. Failed transfers never resume local refresh automatically.

Receiver activation rechecks current owner session, disabled state, access policy, email, registration/subject, host/origin, active work and the prior credential binding. Replacing an account first requires confirmed app-server token and broker fingerprint clearing. If clearing fails, the prior credential is preserved and the transfer requires attention.

Local files use owner-only permissions, descriptor-relative symlink-resistant access, atomic writes, fsync and a kernel-released lock. The reviewed build and synthetic tests use temporary fixtures; production state is created under the user's Application Support directory only when the installed application is run.
