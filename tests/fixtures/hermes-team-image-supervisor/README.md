These upstream scripts are read-only data for the native collision regression. Tests
never execute them. Their original licenses are included alongside them.

`rc.init` is from s6-overlay **3.2.3.0**, extracted from the noarch archive whose
SHA256 is pinned by the Hermes Dockerfile:
`b720f9d9340efc8bb07528b9743813c836e4b02f8693d90241f047998b4c53cf`.
Its SHA256 is `bf6a4575f0029b66913623356e3c56553514a86bcf693fae6432617c73977747`.
The exact script and the init child argument construction are available in
[s6-overlay](https://github.com/just-containers/s6-overlay/blob/v3.2.3.0/layout/rootfs-overlay/package/admin/s6-overlay-%40VERSION%40/etc/s6-linux-init/skel/rc.init)
and [s6-linux-init 1.2.0.1](https://github.com/skarnet/s6-linux-init/blob/v1.2.0.1/src/init/s6-linux-init.c).

`main-wrapper.sh` is byte-for-byte Hermes revision
`f97608f178d1ffeca59860195ab7da295f7c8e5f`, file `docker/main-wrapper.sh`,
SHA256 `f722b0a99d4d544415add8d6b8013c79ec1c2bf3bb145da551474e3c3193b2da`.
This is the wrapper retained as an argument by the supervisor while the broker's
`sleep infinity` container command runs.

Kernel status, ownership and PID tables are synthetic in this regression. Actual
descriptor traversal, symlink refusal, file modes, bounded reads and content hashing
use production code and real temporary files. Original-image execution remains a
separate hosted Docker check.
