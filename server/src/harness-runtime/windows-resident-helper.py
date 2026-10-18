"""Trusted Windows Job Object supervisor and identity/control helper.

The supervisor joins a non-breakaway, kill-on-close job BEFORE spawning a
native Harness. Its creation time and random job name are durably acknowledged
before the Harness can run. Control always verifies creation time and job
membership; a reused numeric PID is never a kill/suspend target.
"""
import ctypes as c
from ctypes import wintypes as w
import json
import os
import subprocess
import sys
import time

K = c.WinDLL('kernel32', use_last_error=True)
N = c.WinDLL('ntdll')
A = c.WinDLL('advapi32', use_last_error=True)
K.LocalFree.argtypes = [c.c_void_p]
A.GetNamedSecurityInfoW.argtypes = [w.LPWSTR, c.c_int, w.DWORD, c.POINTER(c.c_void_p), c.c_void_p,
                                   c.POINTER(c.c_void_p), c.c_void_p, c.POINTER(c.c_void_p)]
A.ConvertSidToStringSidW.argtypes = [c.c_void_p, c.POINTER(w.LPWSTR)]
A.ConvertStringSecurityDescriptorToSecurityDescriptorW.argtypes = [w.LPCWSTR, w.DWORD, c.POINTER(c.c_void_p), c.c_void_p]
A.GetSecurityDescriptorDacl.argtypes = [c.c_void_p, c.POINTER(w.BOOL), c.POINTER(c.c_void_p), c.POINTER(w.BOOL)]
A.SetNamedSecurityInfoW.argtypes = [w.LPWSTR, c.c_int, w.DWORD, c.c_void_p, c.c_void_p, c.c_void_p, c.c_void_p]
A.GetAce.argtypes = [c.c_void_p, w.DWORD, c.POINTER(c.c_void_p)]
INVALID = c.c_void_p(-1).value
K.OpenProcess.argtypes = [w.DWORD, w.BOOL, w.DWORD]
K.OpenProcess.restype = w.HANDLE
K.GetCurrentProcess.restype = w.HANDLE
K.CloseHandle.argtypes = [w.HANDLE]
K.GetProcessTimes.argtypes = [w.HANDLE] + [c.POINTER(w.FILETIME)] * 4
K.GetExitCodeProcess.argtypes = [w.HANDLE, c.POINTER(w.DWORD)]
K.CreateJobObjectW.argtypes = [c.c_void_p, w.LPCWSTR]
K.CreateJobObjectW.restype = w.HANDLE
K.OpenJobObjectW.argtypes = [w.DWORD, w.BOOL, w.LPCWSTR]
K.OpenJobObjectW.restype = w.HANDLE
K.SetInformationJobObject.argtypes = [w.HANDLE, c.c_int, c.c_void_p, w.DWORD]
K.QueryInformationJobObject.argtypes = [w.HANDLE, c.c_int, c.c_void_p, w.DWORD, c.c_void_p]
K.AssignProcessToJobObject.argtypes = [w.HANDLE, w.HANDLE]
K.IsProcessInJob.argtypes = [w.HANDLE, w.HANDLE, c.POINTER(w.BOOL)]
K.TerminateJobObject.argtypes = [w.HANDLE, w.UINT]
N.NtSuspendProcess.argtypes = [w.HANDLE]
N.NtResumeProcess.argtypes = [w.HANDLE]
N.NtSuspendProcess.restype = c.c_long
N.NtResumeProcess.restype = c.c_long

class BasicLimit(c.Structure):
    _fields_ = [('processTime', c.c_longlong), ('jobTime', c.c_longlong),
                ('flags', w.DWORD), ('minimum', c.c_size_t), ('maximum', c.c_size_t),
                ('active', w.DWORD), ('affinity', c.c_size_t), ('priority', w.DWORD),
                ('scheduling', w.DWORD)]

class IoCounters(c.Structure):
    _fields_ = [(name, c.c_ulonglong) for name in
                ['readOps', 'writeOps', 'otherOps', 'readBytes', 'writeBytes', 'otherBytes']]

class ExtendedLimit(c.Structure):
    _fields_ = [('basic', BasicLimit), ('io', IoCounters), ('processMemory', c.c_size_t),
                ('jobMemory', c.c_size_t), ('peakProcess', c.c_size_t), ('peakJob', c.c_size_t)]

def checked(result):
    if not result:
        raise c.WinError(c.get_last_error())
    return result

def sid_string(sid):
    result = w.LPWSTR()
    checked(A.ConvertSidToStringSidW(sid, c.byref(result)))
    try:
        return result.value
    finally:
        K.LocalFree(c.cast(result, c.c_void_p))

def private_file(request):
    file = request['file']
    owner, dacl, descriptor = c.c_void_p(), c.c_void_p(), c.c_void_p()
    status = A.GetNamedSecurityInfoW(file, 1, 1 | 4, c.byref(owner), None, c.byref(dacl), None, c.byref(descriptor))
    if status:
        raise c.WinError(status)
    try:
        owner_sid = sid_string(owner)
        if request.get('protect'):
            replacement, replacement_dacl = c.c_void_p(), c.c_void_p()
            checked(A.ConvertStringSecurityDescriptorToSecurityDescriptorW(
                'D:P(A;;FA;;;SY)(A;;FA;;;' + owner_sid + ')', 1, c.byref(replacement), None))
            try:
                present, defaulted = w.BOOL(), w.BOOL()
                checked(A.GetSecurityDescriptorDacl(replacement, c.byref(present), c.byref(replacement_dacl), c.byref(defaulted)))
                status = A.SetNamedSecurityInfoW(file, 1, 4 | 0x80000000, None, None, replacement_dacl, None)
                if status:
                    raise c.WinError(status)
            finally:
                K.LocalFree(replacement)
            return {'private': True}
        if not dacl:
            return {'private': False}
        # ACL header: revision/size followed by WORD AceCount at byte 4.
        count = c.cast(dacl.value + 4, c.POINTER(w.WORD))[0]
        for index in range(count):
            ace = c.c_void_p()
            checked(A.GetAce(dacl, index, c.byref(ace)))
            ace_type = c.cast(ace, c.POINTER(c.c_ubyte))[0]
            if ace_type in (0, 5, 9, 11):
                if ace_type != 0:
                    return {'private': False}  # Do not guess object/callback ACE semantics.
                principal = sid_string(c.c_void_p(ace.value + 8))
                if principal not in (owner_sid, 'S-1-5-18', 'S-1-3-4'):
                    return {'private': False}
        return {'private': True}
    finally:
        K.LocalFree(descriptor)

def process_handle(pid, access=0x1000):
    handle = K.OpenProcess(access, False, pid)
    if not handle:
        error = c.get_last_error()
        if error == 87:
            return None
        raise c.WinError(error)
    return handle

def creation_time(handle):
    created, exited, kernel, user = [w.FILETIME() for _ in range(4)]
    checked(K.GetProcessTimes(handle, c.byref(created), c.byref(exited), c.byref(kernel), c.byref(user)))
    return str((created.dwHighDateTime << 32) | created.dwLowDateTime)

def identity(pid):
    handle = process_handle(pid)
    if not handle:
        return None
    try:
        status = w.DWORD()
        checked(K.GetExitCodeProcess(handle, c.byref(status)))
        if status.value != 259:
            return None
        return {'pid': pid, 'processGroupId': pid, 'bootId': 'win32', 'startTicks': creation_time(handle)}
    finally:
        K.CloseHandle(handle)

def members(job):
    # DWORD Assigned/Listed followed by aligned ULONG_PTR ProcessIdList.
    capacity = 16384
    buffer = c.create_string_buffer(8 + c.sizeof(c.c_size_t) * capacity)
    checked(K.QueryInformationJobObject(job, 3, buffer, len(buffer), None))
    assigned, listed = c.cast(buffer, c.POINTER(w.DWORD))[:2]
    if listed != assigned or listed > capacity:
        raise RuntimeError('Job process list exceeded the bounded authority scan')
    values = c.cast(c.addressof(buffer) + 8, c.POINTER(c.c_size_t))
    return [int(values[i]) for i in range(listed)]

def open_owned_job(request):
    name = request.get('windowsJobName')
    if not isinstance(name, str) or not name.startswith('Local\\OpenFARS-'):
        raise ValueError('Invalid resident job identity')
    job = K.OpenJobObjectW(0x0004 | 0x0008, False, name)
    if not job:
        if c.get_last_error() == 2:
            return None
        raise c.WinError(c.get_last_error())
    try:
        current = identity(request['pid'])
        if current is None or current['startTicks'] != request['startTicks']:
            if members(job):
                raise RuntimeError('Resident job survived without its acknowledged supervisor identity')
            K.CloseHandle(job)
            return None
        process = process_handle(request['pid'])
        try:
            belongs = w.BOOL()
            checked(K.IsProcessInJob(process, job, c.byref(belongs)))
            if not belongs.value:
                raise RuntimeError('Resident PID is not a member of its acknowledged job')
        finally:
            K.CloseHandle(process)
        return job
    except BaseException:
        K.CloseHandle(job)
        raise

def control(request):
    job = open_owned_job(request)
    if not job:
        return {'alive': False, 'members': []}
    try:
        action = request['action']
        if action == 'probe':
            return {'alive': True, 'members': members(job)}
        if action == 'terminate':
            checked(K.TerminateJobObject(job, 1))
            deadline = time.monotonic() + 5
            while members(job) and time.monotonic() < deadline:
                time.sleep(.01)
            if members(job):
                raise RuntimeError('Owned resident job did not become empty after termination')
            return {'alive': False, 'members': []}
        if action not in ('pause', 'resume'):
            raise ValueError('Invalid resident control action')
        operation = N.NtSuspendProcess if action == 'pause' else N.NtResumeProcess
        controlled = []
        try:
            # Children first, supervisor last. The job disallows breakaway.
            seen = set()
            for _ in range(20):
                pending = [pid for pid in members(job) if pid not in seen]
                pending.sort(key=lambda pid: pid == request['pid'])
                for pid in pending:
                    handle = process_handle(pid, 0x0800 | 0x1000)
                    if handle is None:
                        continue
                    belongs = w.BOOL()
                    checked(K.IsProcessInJob(handle, job, c.byref(belongs)))
                    if not belongs.value:
                        K.CloseHandle(handle)
                        raise RuntimeError('Process escaped its job during control')
                    if operation(handle) < 0:
                        K.CloseHandle(handle)
                        raise RuntimeError('Windows resident process control failed')
                    controlled.append(handle)
                    seen.add(pid)
                if set(members(job)).issubset(seen):
                    return {'alive': True, 'stopped': action == 'pause', 'members': members(job)}
            raise RuntimeError('Resident job did not stabilize during control')
        except BaseException:
            if action == 'pause':
                for handle in reversed(controlled):
                    N.NtResumeProcess(handle)
            raise
        finally:
            for handle in controlled:
                K.CloseHandle(handle)
    finally:
        K.CloseHandle(job)

def atomic_json(file, value):
    temporary = file + '.' + str(os.getpid()) + '.tmp'
    with open(temporary, 'x', encoding='utf-8') as output:
        json.dump(value, output, separators=(',', ':'))
        output.write('\n')
        output.flush()
        os.fsync(output.fileno())
    private_file({'file': temporary, 'protect': True})
    # A Windows reader/scanner can briefly deny delete sharing. The durable
    # acknowledgement must publish before any native Harness may be spawned.
    deadline = time.monotonic() + 2
    while True:
        try:
            os.replace(temporary, file)
            break
        except OSError as error:
            if getattr(error, 'winerror', None) not in (5, 32, 33) or time.monotonic() >= deadline:
                raise
            time.sleep(0.01)

def supervise(file):
    with open(file, encoding='utf-8') as source:
        config = json.load(source)
    with open(config['claimFile'], encoding='utf-8') as source:
        claim = json.load(source)
    if claim['status'] != 'launching' or claim['identity'] != config['identity'] or os.path.exists(config['fenceFile']):
        raise RuntimeError('Resident launch is fenced or changed authority')
    job = checked(K.CreateJobObjectW(None, config['windowsJobName']))
    if c.get_last_error() == 183:
        raise RuntimeError('Resident job name already exists')
    limits = ExtendedLimit()
    limits.basic.flags = 0x2000  # KILL_ON_JOB_CLOSE; no breakaway flags.
    checked(K.SetInformationJobObject(job, 9, c.byref(limits), c.sizeof(limits)))
    checked(K.AssignProcessToJobObject(job, K.GetCurrentProcess()))
    current = identity(os.getpid())
    current['windowsJobName'] = config['windowsJobName']
    atomic_json(config['claimFile'], dict(claim, status='spawned', process=current))
    if os.path.exists(config['fenceFile']):
        os._exit(73)
    os.unlink(file)
    child = subprocess.Popen([config['command'], *config['args']], cwd=config['cwd'],
                             stdin=sys.stdin.buffer, stdout=sys.stdout.buffer, stderr=sys.stderr.buffer,
                             creationflags=0x08000000)
    # The inherited non-breakaway job owns the native process and all MCP/tool
    # descendants even if the service/supervisor is forcibly terminated.
    code = child.wait()
    os._exit(code if code >= 0 else 1)

if __name__ == '__main__':
    if len(sys.argv) == 3 and sys.argv[1] == 'supervise':
        supervise(sys.argv[2])
    else:
        request = json.load(sys.stdin)
        result = private_file(request) if request['action'] == 'private-file' else identity(request['pid']) if request['action'] == 'identity' else control(request)
        sys.stdout.write(json.dumps(result, separators=(',', ':')) + '\n')
