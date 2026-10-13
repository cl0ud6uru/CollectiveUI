# Personal Codex: local image pilot proposal

The broker can use an already installed, complete `sha256:<64 lowercase hex>`
Docker **image config ID**. This is distinct from a verified registry manifest
reference. Do not turn a local RepoDigest into registry provenance. The operator
must compare `docker image inspect <ID>`'s `Id` with the independently recorded
tested image. The broker checks that ID before creating storage and checks both
the container's requested `Config.Image` and actual `Image` on every inspection,
including retained starts and execution bridges. It never builds or pulls an
image. Mutable tags and partial IDs remain rejected.

This route needs no new Codex image. Keep the qualified official binary,
requirements, volumes, namespace policy, credentials, and owner admission
contract. A different container with identical filesystem bytes is not assumed
to have the same Docker config ID; qualify the actual installed ID.

## Proxy artifact and exact configuration

[`personal-codex-egress-proxy.mjs`](../../scripts/personal-codex-egress-proxy.mjs)
is a dependency-free Node CONNECT proxy. Run it with the Node already in the
tested stock image, with the source embedded in `node --input-type=module -e`.
No new base image, npm package, credential mount, TLS interception, custom CA,
published port, or PATH bubblewrap is needed. The renderer embeds the exact
source and reports its SHA-256; the proxy has **zero mounts**. It listens only on
its owner-internal IPv4 address and accepts only that runtime's source IPv4.

The only CONNECT authorities are `auth.openai.com:443` and `chatgpt.com:443`.
The proxy buffers a bounded TLS ClientHello, requires its SNI to match the
CONNECT hostname, resolves that exact hostname, rejects non-public IPv4 answers,
and dials the selected answer directly. Codex validates upstream TLS end to end.
Plain HTTP forwarding, IP authorities, other ports, other names and mismatched
SNI fail closed. ECH without a matching visible SNI is unsupported. The proxy
does not inspect encrypted HTTP Host headers or application paths; the allowlist
is for the TLS destination. The existing native command network sandbox remains
required even when the trusted app-server can reach this proxy.

These hosts are the pinned source defaults at Codex
`a6274249d5877030676db098914db686bab7c921`: device login/exchange
(`login/src/device_code_auth.rs:165–217`, `login/src/server.rs:711–720`), token
refresh/revocation (`login/src/auth/manager.rs:1727–1729`), model catalog
(`model-provider/src/models_endpoint.rs:463–472`) and Responses/WebSocket
(`model-provider-info/src/lib.rs:79–80`,
`codex-api/src/endpoint/responses_websocket.rs:424–427`). Its HTTP and WebSocket
transports support the existing `HTTPS_PROXY=http://codex-egress:3128`.
`api.openai.com` belongs to API-key mode and is excluded from this device-login
pilot. No staging or wildcard domain is admitted.

[`render-personal-codex-pilot-plan.mjs`](../../scripts/render-personal-codex-pilot-plan.mjs)
reads JSON on stdin and **only prints a proposal**. It executes no command.
Supply these exact fields from verified operator records:

```json
{
  "owner": "VERIFIED_EXISTING_OWNER_ID",
  "namespace": "cui-codex-personal",
  "image": "sha256:COMPLETE_TESTED_LOCAL_IMAGE_CONFIG_ID",
  "egressSubnet": "OPERATOR_VERIFIED_UNUSED_PRIVATE_29",
  "uplinkSubnet": "SECOND_OPERATOR_VERIFIED_UNUSED_PRIVATE_29",
  "hostIPv4": ["EVERY_CURRENT_VM_IPV4"],
  "dnsIPv4": ["CURRENT_CONTAINER_REACHABLE_DOCKER_UPSTREAM_DNS_IPV4"]
}
```

Run `node scripts/render-personal-codex-pilot-plan.mjs < approved-input.json > proposal.json`.
Review the resulting literal broker JSON, source hash, Docker argv, and firewall
argv before action-time approval. Protect input/output operator files; never
publish real owner/network records. Neither sample subnets nor display names
are acceptable production inputs.

The owner egress bridge is internal, IPv6 off, isolated gateway, ICC off. In its
private `/29`, `.1` is the reserved gateway, `.3` is the static proxy endpoint,
and `.4–.6` are IPAM auxiliary reservations. Only `.2` remains for the one
dynamic runtime. Verify that address after provisioning, before credentials;
no other endpoint may join. The mount-free proxy also has a dedicated uplink
bridge. Its listener is absent from that interface. The host's `DOCKER-USER`
rules permit only runtime `.2` to own proxy `.3` TCP 3128 and established return
traffic. They deny all other forwarding involving the internal bridge. Uplink
rules allow proxy DNS only to inventoried resolvers, public TCP 443 and
established return; private/special destinations and every host IPv4 are denied.
Separate scoped INPUT drops prevent either bridge from reaching host services.
Private DNS is a narrowly reviewed port-53 exception, not general LAN access.
Host-local DNS requires a separately reviewed recipe and is rejected by this
renderer. Docker's embedded DNS must not provide external resolution for the
internal-only runtime; explicitly test that on the operator's Docker version.
Exact hostname/SNI enforcement belongs to the trusted proxy code. Its firewall
allows public TCP 443 to accommodate CDN address changes; it does not pin those
two names at the kernel layer. A compromised proxy could reach other public
HTTPS origins. Review the embedded source/hash and keep that process outside
the untrusted workspace/credential boundary.

This proposal targets Docker's **iptables** backend with bridge netfilter active.
Verify Engine support for `gateway_mode_ipv4=isolated` before provisioning.
It does not silently enable sysctls, replace host security profiles, change the
firewall backend, or flush shared chains. Inspect existing rule order and bridge
behavior first. Docker documents
[bridge options](https://docs.docker.com/engine/network/drivers/bridge/),
[IPAM auxiliary reservations](https://docs.docker.com/reference/cli/docker/network/create/)
and [`DOCKER-USER` precedence](https://docs.docker.com/engine/network/firewall-iptables/).
An nftables host needs a separately reviewed equivalent. Persist and roll back
only the approved owner-scoped rules. Preserve both private volumes and backups.

## Identity reconciliation and approval boundary

`changeConnection` locks/rereads the owner, checks the current session and policy,
then requires the native ChatGPT email to equal the CollectiveUI email or UPN
case-insensitively. An existing local account with null email and `local:<name>`
UPN therefore cannot confirm a ChatGPT grant. The local account UI/CLI currently
has no email editor. Do not create another owner, change the UPN, reset a password,
add email login aliases, bypass the match, or bind a native grant directly.

After the user confirms the existing owner and exact ChatGPT email, propose an
operator transaction that uses the existing local-account advisory lock and
owner row lock; verifies the expected local realm, username, enabled state,
completed password change and still-null email; checks that the email is not
associated with another user/UPN/login alias; updates only `users.email` plus
session-version/auth-change invalidation; and writes an audit event. Abort on
any mismatch or active/nonterminal Codex work. Do not log secrets or tokens.
Require fresh CollectiveUI sign-in, then the ordinary native device flow and
confirmation. The pilot approval must name that identity mutation explicitly.

The trusted broker uses the reviewed worker artifact with
`node --import tsx src/personal-codex/main.ts`. Docker socket access is confined to
that broker and grants host-level authority. Web/worker receive only the
protected broker IPC directory, never Docker access. The exact service artifact,
UID/GID, directory ownership and mount placement remain operator inputs: dir
0750 without group write, socket 0660, markers 0600. No broker socket, Docker
socket, config, credential, or owner volume is mounted in the proxy.
The worker Dockerfile does not install a Docker client. The proposed broker
cannot execute `/usr/bin/docker` merely by mounting `docker.sock`. The shortest
route reuses the operator's existing Linux Docker client as a read-only broker
executable mount, **only after** recording its SHA-256, resolving symlinks and
verifying it executes in that worker image without missing libraries. If it is
not compatible, a separately reviewed broker packaging change is required.
Neither the web/worker nor personal runtime receives that executable or socket.

## Validation and remaining acceptance

Unit tests exercise local ID admission, wrong-image rejection before private
storage creation, retained-container mismatch rejection, two real synthetic TLS
round trips, CONNECT/SNI/private-DNS denial, fragmentation, and renderer inputs.
The synthetic key/cert in `tests/fixtures/personal-codex-egress` authenticate no
account. For a reproducible offline smoke against an installed image:

```sh
node scripts/check-personal-codex-proxy-image.mjs sha256:COMPLETE_LOCAL_IMAGE_ID
```

This uses a disposable non-root/read-only/cap-drop-ALL container on `network=none`
with no mounts. It checks Docker's requested/actual IDs and the real Node TLS
proxy with synthetic loopback endpoints, then removes only that container.
It does not claim production wire-policy or live model-account acceptance.

Before credentials, the operator must inspect exact IPAM assignments, zero proxy
mounts, source hash and command, two proxy networks, one runtime network, no
published ports, rules and unchanged sandbox profile. Check both allowed hosts
with valid upstream certificate verification, then prove wrong CONNECT/SNI,
direct IP/host/LAN/other-peer access, external runtime DNS, proxy-uplink listener
access and native command proxy bypass are denied. Rerun the native sandbox
matrix with direct/symlink protected reads, metadata, parent sentinel integrity,
workspace/helper/Git execution, process isolation, network positive/negative
controls and replacement/persistence. Finally, after separate credential and
activation approval, the user performs device login, owner confirmation and an
actual model turn. Restart/persistence and disconnect/rollback must be verified.
Nothing in this change activates a broker, identity update, network or grant.
