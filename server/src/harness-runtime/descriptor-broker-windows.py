"""Windows filesystem broker using retained, non-delete-shared handles.

Every ancestor remains open without FILE_SHARE_DELETE until an operation ends.
Roots remain pinned for the helper lifetime. OPEN_REPARSE_POINT plus handle
inspection rejects junctions, symlinks and mounts before traversing them.
"""
import base64
import ctypes as c
from ctypes import wintypes as w
import hashlib
import json
import os
import re
import secrets
import sys

K = c.WinDLL('kernel32', use_last_error=True)
K.CreateFileW.argtypes = [w.LPCWSTR, w.DWORD, w.DWORD, c.c_void_p, w.DWORD, w.DWORD, w.HANDLE]
K.CreateFileW.restype = w.HANDLE
K.CloseHandle.argtypes = [w.HANDLE]
K.GetFileType.argtypes = [w.HANDLE]
K.GetFinalPathNameByHandleW.argtypes = [w.HANDLE, w.LPWSTR, w.DWORD, w.DWORD]
K.GetFileInformationByHandle.argtypes = [w.HANDLE, c.c_void_p]
K.ReadFile.argtypes = [w.HANDLE, c.c_void_p, w.DWORD, c.POINTER(w.DWORD), c.c_void_p]
K.SetFilePointerEx.argtypes = [w.HANDLE, c.c_longlong, c.POINTER(c.c_longlong), w.DWORD]
K.WriteFile.argtypes = [w.HANDLE, c.c_void_p, w.DWORD, c.POINTER(w.DWORD), c.c_void_p]
K.FlushFileBuffers.argtypes = [w.HANDLE]
K.CreateDirectoryW.argtypes = [w.LPCWSTR, c.c_void_p]
K.MoveFileExW.argtypes = [w.LPCWSTR, w.LPCWSTR, w.DWORD]
K.SetFileInformationByHandle.argtypes = [w.HANDLE, c.c_int, c.c_void_p, w.DWORD]
INVALID = c.c_void_p(-1).value
ROOTS = {}

class FileInfo(c.Structure):
    _fields_ = [('attributes', w.DWORD), ('created', w.FILETIME), ('accessed', w.FILETIME),
                ('written', w.FILETIME), ('volume', w.DWORD), ('sizeHigh', w.DWORD),
                ('sizeLow', w.DWORD), ('links', w.DWORD), ('indexHigh', w.DWORD), ('indexLow', w.DWORD)]

def checked(value):
    if not value:
        raise c.WinError(c.get_last_error())
    return value

def info(handle):
    value = FileInfo()
    checked(K.GetFileInformationByHandle(handle, c.byref(value)))
    if value.attributes & 0x400:
        raise ValueError('Reparse points are refused')
    if K.GetFileType(handle) != 1:
        raise ValueError('Target must be on a disk filesystem')
    return value

def read_version(value):
    identity = (value.volume, value.indexHigh, value.indexLow, value.sizeHigh, value.sizeLow,
                value.written.dwHighDateTime, value.written.dwLowDateTime)
    return hashlib.sha256(repr(identity).encode('ascii')).hexdigest()

def final_path(handle):
    buffer = c.create_unicode_buffer(32768)
    size = checked(K.GetFinalPathNameByHandleW(handle, buffer, len(buffer), 0))
    if size >= len(buffer):
        raise ValueError('Pinned path exceeded limit')
    return buffer.value

def canonical(value):
    if value.startswith('\\\\?\\UNC\\'):
        value = '\\\\' + value[8:]
    elif value.startswith('\\\\?\\'):
        value = value[4:]
    return os.path.normpath(value).casefold()

def open_handle(file, directory, access=0x80000000, disposition=3):
    handle = K.CreateFileW(file, access, 3, None, disposition, 0x00200000 | 0x02000000, None)
    if handle == INVALID:
        raise c.WinError(c.get_last_error())
    try:
        value = info(handle)
        if bool(value.attributes & 0x10) != directory:
            raise ValueError('Unexpected target type')
        return handle
    except BaseException:
        K.CloseHandle(handle)
        raise

def components(value, empty=False):
    if empty and value in (None, ''):
        return []
    if not isinstance(value, str) or not value or any(ch in value for ch in '\\:\x00'):
        raise ValueError('Path must be a normalized relative path without ADS')
    parts = value.split('/')
    for part in parts:
        if not part or part in ('.', '..') or part.endswith((' ', '.')) or '~' in part:
            raise ValueError('Path traversal or ambiguous Windows component refused')
        if part.casefold() == '.git' or re.match(r'^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)', part, re.I):
            raise ValueError('Reserved Windows or Git path refused')
    return parts

def root_for(request, write=False):
    root = ROOTS.get(request.get('rootId'))
    if root is None or (write and not root['write']):
        raise PermissionError('Unknown or read-only root')
    return root

def write_files(item):
    if 'writeFiles' not in item:
        return None
    files = item['writeFiles']
    if item.get('write') is not True or not isinstance(files, list) or not 1 <= len(files) <= 1000:
        raise ValueError('Invalid exact writable files')
    for file in files:
        components(file)
        if len(file) > 4096 or any(ord(ch) < 32 or ord(ch) == 127 or ch in '*?[]' for ch in file):
            raise ValueError('Invalid exact writable file')
    if len(set(files)) != len(files) or any(other.startswith(file + '/') for file in files for other in files if other != file):
        raise ValueError('Duplicate or overlapping exact writable files')
    return frozenset(files)

def pin_parents(root, parts, create=False):
    current = root['handle']
    retained = []
    try:
        for part in parts:
            child = os.path.join(final_path(current), part)
            if create and not K.CreateDirectoryW(child, None) and c.get_last_error() != 183:
                raise c.WinError(c.get_last_error())
            current = open_handle(child, True)
            retained.append(current)
            if info(current).volume != root['volume']:
                raise ValueError('Filesystem volume crossing refused')
        return current, retained
    except BaseException:
        for handle in reversed(retained):
            K.CloseHandle(handle)
        raise

def dispatch(request):
    action = request.get('action')
    if action == 'initialize':
        if ROOTS or not isinstance(request.get('roots'), list) or not request['roots']:
            raise ValueError('Roots must be initialized exactly once')
        try:
            for root in request['roots']:
                if not root.get('id') or root['id'] in ROOTS or not os.path.isabs(root['path']):
                    raise ValueError('Invalid root')
                exact_files = write_files(root)
                handle = open_handle(root['path'], True)
                if canonical(final_path(handle)) != canonical(root['path']):
                    K.CloseHandle(handle)
                    raise ValueError('Root changed its canonical path before pinning')
                ROOTS[root['id']] = {'handle': handle, 'volume': info(handle).volume, 'write': root.get('write') is True, 'writeFiles': exact_files}
            if any(root['writeFiles'] is not None for root in ROOTS.values()) and any(
                    root['write'] and root['writeFiles'] is None for root in ROOTS.values()):
                raise ValueError('Closing manifests cannot coexist with unrestricted writable roots')
            return {'rootIds': sorted(ROOTS), 'primitive': 'win32-pinned-handles'}
        except BaseException:
            for root in ROOTS.values():
                K.CloseHandle(root['handle'])
            ROOTS.clear()
            raise
    if action == 'close':
        return {'closed': True}
    if action == 'matrix':
        return {'rootIds': sorted(ROOTS), 'primitive': 'win32-pinned-handles',
                'closingFiles': {key: sorted(value['writeFiles']) for key, value in ROOTS.items() if value['writeFiles'] is not None},
                'resolve': ['PINNED_ANCESTORS', 'NO_REPARSE_POINTS', 'NO_ADS', 'NO_XDEV']}
    if action not in ('read', 'write', 'list', 'mkdir', 'remove'):
        raise ValueError('Unsupported broker action')
    root = root_for(request, action in ('write', 'mkdir', 'remove'))
    parts = components(request.get('relativePath'), action == 'list')
    if action in ('write', 'mkdir', 'remove') and root['writeFiles'] is not None:
        if action == 'mkdir' or '/'.join(parts) not in root['writeFiles']:
            raise PermissionError('Path is outside the explicit closing file manifest')
    if action == 'remove' and root['writeFiles'] is None:
        raise PermissionError('File removal requires an explicit closing manifest')
    current, retained = pin_parents(root, parts if action in ('list', 'mkdir') else parts[:-1], action == 'mkdir')
    try:
        if action == 'mkdir':
            return {'created': True, 'components': len(parts)}
        if action == 'list':
            offset, limit = request.get('offset', 0), request.get('limit', 200)
            if type(offset) is not int or offset < 0 or type(limit) is not int or not 1 <= limit <= 1000:
                raise ValueError('Invalid directory page')
            rows = []
            for entry in os.scandir(final_path(current)):
                if entry.name.casefold() == '.git':
                    continue
                value = entry.stat(follow_symlinks=False)
                attrs = value.st_file_attributes
                kind = 'symlink' if attrs & 0x400 else 'directory' if attrs & 0x10 else 'file'
                rows.append({'name': entry.name, 'type': kind, 'bytes': value.st_size})
                if len(rows) > 10000:
                    raise ValueError('Directory exceeds bounded listing limit')
            rows.sort(key=lambda row: row['name'])
            page = rows[offset:offset + limit]
            return {'entries': page, 'offset': offset, 'limit': limit, 'total': len(rows), 'hasMore': offset + len(page) < len(rows)}
        target = os.path.join(final_path(current), parts[-1])
        if action == 'remove':
            try:
                handle = open_handle(target, False, 0x80000000 | 0x00010000)
            except OSError as error:
                if error.winerror == 2:
                    return {'removed': False}
                raise
            try:
                if info(handle).links != 1:
                    raise ValueError('Aliased removal target refused')
                delete = w.BOOL(True)
                checked(K.SetFileInformationByHandle(handle, 4, c.byref(delete), c.sizeof(delete)))
            finally:
                K.CloseHandle(handle)
            return {'removed': True}
        if action == 'read':
            handle = open_handle(target, False)
            try:
                limit = request.get('maxBytes', 4 * 1024 * 1024)
                if type(limit) is not int or not 0 <= limit <= 64 * 1024 * 1024:
                    raise ValueError('Invalid read limit')
                value = info(handle)
                size = (value.sizeHigh << 32) | value.sizeLow
                paged = 'offset' in request
                offset = request.get('offset', 0)
                version = read_version(value)
                if paged:
                    if type(offset) is not int or not 0 <= offset <= size or not 1 <= limit <= 4 * 1024 * 1024:
                        raise ValueError('Invalid read page')
                    expected = request.get('expectedVersion')
                    if expected is not None and expected != version:
                        raise ValueError('Read file version changed; reread the required page')
                    checked(K.SetFilePointerEx(handle, offset, None, 0))
                elif size > limit:
                    raise ValueError(f'Read target exceeds maxBytes (file size={size}); use offset=0 with maxBytes for a bounded page')
                chunks, remaining = [], min(limit, size - offset) if paged else limit + 1
                while remaining:
                    buffer = c.create_string_buffer(min(remaining, 65536))
                    count = w.DWORD()
                    checked(K.ReadFile(handle, buffer, len(buffer), c.byref(count), None))
                    if not count.value:
                        break
                    chunks.append(buffer.raw[:count.value])
                    remaining -= count.value
                data = b''.join(chunks)
                if paged and read_version(info(handle)) != version:
                    raise ValueError('Read file changed during page read')
                if len(data) > limit:
                    raise ValueError('Read target exceeds maxBytes')
                result = {'bytes': len(data), 'sha256': hashlib.sha256(data).hexdigest(), 'contentBase64': base64.b64encode(data).decode()}
                if paged:
                    result.update({'offset': offset, 'nextOffset': offset + len(data), 'totalBytes': size,
                                   'eof': offset + len(data) == size, 'version': version})
                return result
            finally:
                K.CloseHandle(handle)
        try:
            existing = open_handle(target, False)
            try:
                if info(existing).links != 1:
                    raise ValueError('Aliased write target refused')
            finally:
                K.CloseHandle(existing)
        except OSError as error:
            if error.winerror != 2:
                raise
        data = base64.b64decode(request['contentBase64'], validate=True)
        if len(data) > 64 * 1024 * 1024:
            raise ValueError('Write payload exceeds limit')
        temporary = os.path.join(final_path(current), '.openfars-' + secrets.token_hex(16) + '.tmp')
        handle = open_handle(temporary, False, 0x40000000, 1)
        try:
            written = 0
            while written < len(data):
                chunk = data[written:written + 65536]
                count = w.DWORD()
                checked(K.WriteFile(handle, chunk, len(chunk), c.byref(count), None))
                if not count.value:
                    raise OSError('Write made no progress')
                written += count.value
            checked(K.FlushFileBuffers(handle))
        finally:
            K.CloseHandle(handle)
        try:
            checked(K.MoveFileExW(temporary, target, 1 | 8))
        finally:
            if os.path.exists(temporary):
                os.unlink(temporary)
        return {'bytes': len(data), 'sha256': hashlib.sha256(data).hexdigest()}
    finally:
        for handle in reversed(retained):
            K.CloseHandle(handle)

for raw in sys.stdin:
    request = {}
    try:
        request = json.loads(raw)
        response = {'id': request.get('id'), 'ok': True, 'result': dispatch(request)}
    except Exception as error:
        response = {'id': request.get('id'), 'ok': False, 'error': {'type': type(error).__name__, 'message': str(error)}}
    sys.stdout.write(json.dumps(response, separators=(',', ':')) + '\n')
    sys.stdout.flush()
    if request.get('action') == 'close':
        break
