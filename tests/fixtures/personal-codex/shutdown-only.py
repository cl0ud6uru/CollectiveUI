import ctypes, errno, json, os, platform, subprocess

if platform.machine() != 'x86_64':
    raise SystemExit('Synthetic reproduction supports reviewed x86_64 only.')
libc = ctypes.CDLL(None, use_errno=True)
class Filter(ctypes.Structure):
    _fields_ = [('code', ctypes.c_ushort), ('jt', ctypes.c_ubyte), ('jf', ctypes.c_ubyte), ('k', ctypes.c_uint)]
class Program(ctypes.Structure):
    _fields_ = [('length', ctypes.c_ushort), ('filter', ctypes.POINTER(Filter))]
# seccomp_data.arch then nr; reject foreign ABI, deny shutdown(48), allow rest.
filters = (Filter * 7)(Filter(0x20,0,0,4), Filter(0x15,1,0,0xc000003e), Filter(0x06,0,0,0x80000000),
    Filter(0x20,0,0,0), Filter(0x15,0,1,48), Filter(0x06,0,0,0x00050000 | errno.EPERM), Filter(0x06,0,0,0x7fff0000))
program = Program(len(filters), filters)
if libc.prctl(38, 1, 0, 0, 0) != 0 or libc.prctl(22, 2, ctypes.byref(program), 0, 0) != 0:
    raise OSError(ctypes.get_errno(), 'Cannot install disposable child shutdown-only filter.')
source = r'''
const cp=require('node:child_process');
const summarize = result => ({status:result.status,signal:result.signal,error:result.error?{code:result.error.code,syscall:result.error.syscall}:null,stdout:result.stdout,stderr:result.stderr});
for (const [label,stdio] of [['default',undefined],['ignored-stdin',['ignore','pipe','pipe']]]) {
 const result=cp.spawnSync(process.execPath,['-e','process.stdout.write("fixture-child-executed");'],{encoding:'utf8',...(stdio?{stdio}:{})});
 console.log(JSON.stringify({label,node:process.versions.node,uv:process.versions.uv,...summarize(result)}));
}
'''
result = subprocess.run(['node', '-e', source], text=True, capture_output=True, timeout=10,
    env={'PATH':'/usr/local/bin:/usr/bin:/bin','HOME':'/nonexistent'})
print(json.dumps({'exitCode':result.returncode, 'stdout':result.stdout, 'stderr':result.stderr}))
raise SystemExit(result.returncode)
