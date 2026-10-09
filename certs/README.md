# Internal CA certificates

`docker-compose.yml` mounts this folder read-only at `/etc/portal/certs` in the web and worker containers. Everything
here except this README is ignored by git.

For LDAPS, put your internal root CA certificate here as a PEM file and point `.env` at the path inside the container:

```
LDAP_CA_CERT=/etc/portal/certs/corp-root-ca.pem
```

## Getting the root CA from Active Directory

Domain controllers often send only their own certificate, not the chain, so Node can't verify the connection until it
has the root CA. AD publishes it at `CN=AIA,CN=Public Key Services,CN=Services,CN=Configuration,<your domain DN>`.

On a domain-joined Windows machine:

1. Open `certlm.msc` and go to **Trusted Root Certification Authorities → Certificates**.
2. Right-click your company's root CA, choose **All Tasks → Export**, and pick **Base-64 encoded X.509 (.CER)**.
3. Copy the file here. A Base-64 `.cer` is already PEM, so renaming it to `.pem` is enough.

Or from Linux with the service account (`ldap-utils` installed):

```bash
ldapsearch -LLL -H ldaps://dc01.corp.example.com -D "$LDAP_BIND_DN" -W \
  -b "CN=AIA,CN=Public Key Services,CN=Services,CN=Configuration,DC=corp,DC=example,DC=com" \
  -o ldif-wrap=no cACertificate \
  | awk '/^cACertificate::/ {print "-----BEGIN CERTIFICATE-----"; print $2; print "-----END CERTIFICATE-----"}' \
  | fold -w 64 > certs/corp-root-ca.pem
```

The `ldapsearch` call itself needs to trust the server for this one lookup. If it fails on the certificate, run it once
with `LDAPTLS_REQCERT=allow` and compare the exported certificate's fingerprint (`openssl x509 -noout -fingerprint
-sha256 -in certs/corp-root-ca.pem`) with the one shown in `certlm.msc`.

Check that the chain verifies before restarting the stack:

```bash
openssl s_client -connect dc01.corp.example.com:636 -CAfile certs/corp-root-ca.pem </dev/null | grep "Verify return code"
```
