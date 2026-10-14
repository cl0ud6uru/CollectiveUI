# Local Codex desktop image

This image adds a private 1280×800 Xvfb desktop to an operator-provided personal Codex image. It runs the stock `/opt/collective-codex/server.mjs` and stock Codex app-server in the same container. It does not add a remote desktop service or an HTTP control endpoint.

Build only from a reviewed immutable image digest:

```sh
docker build -f docker/computer/Dockerfile \
  --build-arg BASE_IMAGE='collectiveui/personal-codex@sha256:<reviewed-digest>' \
  -t collectiveui/personal-codex-computer:local .
```

Run it with the same owner-scoped Codex home and workspace volumes, network policy, resource limits, read-only root, and security profile used by the personal Codex runtime. Keep uid/gid `10001:10001`, do not publish ports, mount host X11 sockets, or add Docker socket access. The X server listens only on its local Unix socket and disables TCP. Fluxbox and headed Chromium run inside the bundled Codex bubblewrap with a private PID namespace and `/proc`; `/codex-home`, `/sys`, the app-server socket, control state, and workspace `.codex` metadata are masked. Only the account workspace, a fresh temporary directory, the authenticated X socket, and the normal container network are available to the GUI. The profile is in the account-owned workspace at `.computer-profile`.

Desktop capture and input are available only through the trusted host broker. It invokes the private control script inside the container; the agent shell has no direct access to the X socket, display cookie, app-server socket, or process-state file. Screenshots are returned as bounded JPEG bytes and are not saved inside the container. Input is one strict JSON object using one of these shapes:

```json
{"kind":"click","x":640,"y":400,"button":"left"}
{"kind":"type","text":"text up to 4000 characters"}
{"kind":"key","key":"Enter"}
{"kind":"scroll","direction":"down","amount":3}
```

Coordinates are display pixels from the top left. Supported buttons are `left`, `middle`, and `right`. Supported keys are `Enter`, `Tab`, `Escape`, `Backspace`, `ArrowUp`, `ArrowDown`, `ArrowLeft`, `ArrowRight`, `Control+a`, `Control+c`, and `Control+v`. Input parsing is strict, arguments are passed directly to fixed executables, and text is sent through stdin; arbitrary shell commands are never evaluated. The private pause and resume commands are reserved for the host broker, which calls them with `docker exec`; the managed Codex filesystem policy denies the agent access to control state and display resources.

This documents a local image build. It does not provision account storage, enroll owners, change existing Docker runtime policy, or claim production containment. The operator must verify the derived image and its runtime settings before enabling it.
