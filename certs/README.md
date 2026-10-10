# Internal CA certificates

Compose mounts this folder read-only at `/etc/portal/certs` in web and worker. Its contents (except this README) are git-ignored and excluded from the Docker build context. Store only approved public CA certificates here, never private keys or credentials.

For LDAPS, obtain your organization's root CA and any required intermediate CA certificates through your PKI administrator or an already trusted domain-joined machine. On Windows, open `certlm.msc`, select the approved certificate under **Trusted Root Certification Authorities → Certificates**, and export **Base-64 encoded X.509 (.CER)** without a private key. A Base-64 `.cer` is PEM; a binary DER export must be converted with `openssl x509 -inform DER -in exported.cer -out certs/corp-root-ca.pem`. Export required intermediates from **Intermediate Certification Authorities** and concatenate only the approved PEM certificates into the CA bundle if needed.

Verify the SHA-256 fingerprint against the value supplied through a trusted, independent channel by your PKI administrator:

```bash
openssl x509 -noout -subject -issuer -dates -fingerprint -sha256 -in certs/corp-root-ca.pem
```

Do not obtain the initial trust anchor from an unverified LDAP connection or disable TLS verification to retrieve it. Keep `LDAP_TLS_REJECT_UNAUTHORIZED=true`; weak server keys, expired certificates and hostname mismatches need correction at the directory/PKI service.

Point `.env` at the **container path**, not the checkout's host path:

```dotenv
LDAP_CA_CERT=/etc/portal/certs/corp-root-ca.pem
```

Ensure the directory is traversable and these public PEM files are readable by the non-root container `app` user (normally directory mode 755 and certificate mode 644, subject to your host's mount policy). The mount is read-only; restarting/recreating web and worker makes configuration changes effective. The worker also uses LDAP for authentication checks. Native Node installations use a host path instead.

Before startup, an operator can check the intended DC's chain **and DNS hostname** using the same CA bundle. Replace the hostname with the one in `LDAP_URL`:

```bash
openssl s_client -connect dc01.corp.example.com:636 \
  -servername dc01.corp.example.com -verify_hostname dc01.corp.example.com \
  -verify_return_error -CAfile certs/corp-root-ca.pem </dev/null
```

Require exit status zero and successful verification. Do not pipe to `grep`, which can hide OpenSSL's failure status. This operator check contacts the directory; it is separate from the offline project tests and does not prove the service-account bind or directory searches succeed. Once approved for your deployment, verify sign-in and group lookup, then check the web logs for sanitized failures.
