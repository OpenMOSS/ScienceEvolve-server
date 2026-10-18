#!/usr/bin/env python3
"""Byte-pinned Linux openat2 broker. The model never receives host paths."""

import base64
import ctypes
import errno
import hashlib
import json
import os
import secrets
import stat
import sys

SYS_OPENAT2 = 437
RESOLVE_NO_XDEV = 0x01
RESOLVE_NO_MAGICLINKS = 0x02
RESOLVE_NO_SYMLINKS = 0x04
RESOLVE_BENEATH = 0x08
RESOLVE_FLAGS = (
    RESOLVE_NO_XDEV | RESOLVE_NO_MAGICLINKS | RESOLVE_NO_SYMLINKS | RESOLVE_BENEATH
)


class OpenHow(ctypes.Structure):
    _fields_ = [
        ("flags", ctypes.c_ulonglong),
        ("mode", ctypes.c_ulonglong),
        ("resolve", ctypes.c_ulonglong),
    ]


LIBC = ctypes.CDLL(None, use_errno=True)
ROOTS = {}


def normalized_relative(value, allow_empty=False):
    if allow_empty and (value is None or value == ""):
        return []
    if not isinstance(value, str) or not value or "\x00" in value:
        raise ValueError("relativePath must be a non-empty string")
    if os.path.isabs(value) or "\\" in value:
        raise ValueError("absolute or platform-ambiguous path refused")
    parts = value.split("/")
    if any(part in ("", ".", "..") for part in parts):
        raise ValueError("path traversal or empty component refused")
    if any(part == ".git" for part in parts):
        raise ValueError("shared .git paths are protected")
    return parts


def openat2(dir_fd, relative, flags, mode=0):
    how = OpenHow(flags, mode, RESOLVE_FLAGS)
    result = LIBC.syscall(
        SYS_OPENAT2,
        dir_fd,
        relative.encode("utf-8"),
        ctypes.byref(how),
        ctypes.sizeof(how),
    )
    if result < 0:
        code = ctypes.get_errno()
        raise OSError(code, os.strerror(code), relative)
    return result


def root_for(request, write=False):
    root_id = request.get("rootId")
    root = ROOTS.get(root_id)
    if root is None:
        raise ValueError("unknown opaque root id")
    if write and not root["write"]:
        raise PermissionError(errno.EACCES, "root is read-only")
    return root


def write_files(item):
    if "writeFiles" not in item:
        return None
    files = item["writeFiles"]
    if item.get("write") is not True or not isinstance(files, list) or not 1 <= len(files) <= 1000:
        raise ValueError("invalid exact writable files")
    for file in files:
        normalized_relative(file)
        if len(file) > 4096 or any(ord(ch) < 32 or ord(ch) == 127 or ch in ':*?[]' for ch in file):
            raise ValueError("invalid exact writable file")
    if len(set(files)) != len(files) or any(other.startswith(file + '/') for file in files for other in files if other != file):
        raise ValueError("duplicate or overlapping exact writable files")
    return frozenset(files)


def require_file_write(root, parts):
    if root["writeFiles"] is not None and '/'.join(parts) not in root["writeFiles"]:
        raise PermissionError(errno.EACCES, "file is outside the explicit closing manifest")


def read_version(info):
    identity = (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns)
    return hashlib.sha256(repr(identity).encode("ascii")).hexdigest()


def read_file(request):
    root = root_for(request)
    relative = "/".join(normalized_relative(request.get("relativePath")))
    # Opening a FIFO for read blocks before fstat can reject it. O_NONBLOCK
    # keeps every untrusted target type fail-closed and bounded.
    fd = openat2(
        root["fd"],
        relative,
        os.O_RDONLY | os.O_CLOEXEC | os.O_NOFOLLOW | os.O_NONBLOCK,
    )
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode):
            raise ValueError("read target must be a regular file")
        limit = request.get("maxBytes", 4 * 1024 * 1024)
        if type(limit) is not int or limit < 0 or limit > 64 * 1024 * 1024:
            raise ValueError("invalid read limit")
        paged = "offset" in request
        offset = request.get("offset", 0)
        version = read_version(info)
        if paged:
            if type(offset) is not int or not 0 <= offset <= info.st_size or not 1 <= limit <= 4 * 1024 * 1024:
                raise ValueError("invalid read page")
            expected = request.get("expectedVersion")
            if expected is not None and expected != version:
                raise ValueError("read file version changed; reread the required page")
            os.lseek(fd, offset, os.SEEK_SET)
        chunks = []
        remaining = min(limit, info.st_size - offset) if paged else limit + 1
        while remaining:
            chunk = os.read(fd, min(remaining, 65536))
            if not chunk:
                break
            chunks.append(chunk)
            remaining -= len(chunk)
        data = b"".join(chunks)
        if paged and read_version(os.fstat(fd)) != version:
            raise ValueError("read file changed during page read")
        if len(data) > limit:
            raise ValueError(f"read target exceeds maxBytes (file size={info.st_size}); use offset=0 with maxBytes for a bounded page")
        result = {
            "bytes": len(data),
            "sha256": hashlib.sha256(data).hexdigest(),
            "contentBase64": base64.b64encode(data).decode("ascii"),
        }
        if paged:
            result.update({"offset": offset, "nextOffset": offset + len(data),
                           "totalBytes": info.st_size, "eof": offset + len(data) == info.st_size,
                           "version": version})
        return result
    finally:
        os.close(fd)


def write_file(request):
    root = root_for(request, write=True)
    parts = normalized_relative(request.get("relativePath"))
    require_file_write(root, parts)
    parent_relative = "/".join(parts[:-1])
    name = parts[-1]
    parent_fd = os.dup(root["fd"]) if not parent_relative else openat2(
        root["fd"],
        parent_relative,
        os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC | os.O_NOFOLLOW,
    )
    temporary = f".openfars-{secrets.token_hex(16)}.tmp"
    temporary_fd = None
    try:
        try:
            existing = os.stat(name, dir_fd=parent_fd, follow_symlinks=False)
            if not stat.S_ISREG(existing.st_mode) or existing.st_nlink != 1:
                raise ValueError("write target must be an unaliased regular file")
        except FileNotFoundError:
            pass
        encoded = request.get("contentBase64")
        if not isinstance(encoded, str):
            raise ValueError("contentBase64 must be a string")
        data = base64.b64decode(encoded, validate=True)
        if len(data) > 64 * 1024 * 1024:
            raise ValueError("write payload exceeds limit")
        temporary_fd = os.open(
            temporary,
            os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_CLOEXEC | os.O_NOFOLLOW,
            0o600,
            dir_fd=parent_fd,
        )
        written = 0
        while written < len(data):
            written += os.write(temporary_fd, data[written:])
        os.fsync(temporary_fd)
        os.close(temporary_fd)
        temporary_fd = None
        os.replace(temporary, name, src_dir_fd=parent_fd, dst_dir_fd=parent_fd)
        os.fsync(parent_fd)
        return {"bytes": len(data), "sha256": hashlib.sha256(data).hexdigest()}
    finally:
        if temporary_fd is not None:
            os.close(temporary_fd)
        try:
            os.unlink(temporary, dir_fd=parent_fd)
        except FileNotFoundError:
            pass
        os.close(parent_fd)


def remove_file(request):
    root = root_for(request, write=True)
    parts = normalized_relative(request.get("relativePath"))
    if root["writeFiles"] is None:
        raise PermissionError(errno.EACCES, "file removal requires an explicit closing manifest")
    require_file_write(root, parts)
    parent_relative = '/'.join(parts[:-1])
    parent_fd = os.dup(root['fd']) if not parent_relative else openat2(
        root['fd'], parent_relative, os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC | os.O_NOFOLLOW)
    try:
        try:
            target = os.stat(parts[-1], dir_fd=parent_fd, follow_symlinks=False)
        except FileNotFoundError:
            return {"removed": False}
        if not stat.S_ISREG(target.st_mode) or target.st_nlink != 1:
            raise ValueError("remove target must be an unaliased regular file")
        os.unlink(parts[-1], dir_fd=parent_fd)
        os.fsync(parent_fd)
        return {"removed": True}
    finally:
        os.close(parent_fd)


def list_directory(request):
    root = root_for(request)
    parts = normalized_relative(request.get("relativePath"), allow_empty=True)
    relative = "/".join(parts)
    directory_fd = os.dup(root["fd"]) if not relative else openat2(
        root["fd"],
        relative,
        os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC | os.O_NOFOLLOW,
    )
    try:
        offset = request.get("offset", 0)
        limit = request.get("limit", 200)
        if (
            not isinstance(offset, int)
            or offset < 0
            or not isinstance(limit, int)
            or limit < 1
            or limit > 1000
        ):
            raise ValueError("invalid directory page")
        rows = []
        with os.scandir(directory_fd) as iterator:
            for entry in iterator:
                if entry.name == ".git":
                    continue
                info = entry.stat(follow_symlinks=False)
                rows.append((entry.name, info))
                if len(rows) > 10000:
                    raise ValueError("directory exceeds bounded listing limit")
        rows.sort(key=lambda row: row[0])
        entries = []
        for name, info in rows[offset : offset + limit]:
            if stat.S_ISREG(info.st_mode):
                kind = "file"
            elif stat.S_ISDIR(info.st_mode):
                kind = "directory"
            elif stat.S_ISLNK(info.st_mode):
                kind = "symlink"
            else:
                kind = "other"
            entries.append({"name": name, "type": kind, "bytes": info.st_size})
        return {
            "entries": entries,
            "offset": offset,
            "limit": limit,
            "total": len(rows),
            "hasMore": offset + len(entries) < len(rows),
        }
    finally:
        os.close(directory_fd)


def make_directory(request):
    root = root_for(request, write=True)
    if root["writeFiles"] is not None:
        raise PermissionError(errno.EACCES, "closing manifests do not authorize directory creation")
    parts = normalized_relative(request.get("relativePath"))
    parent_fd = os.dup(root["fd"])
    try:
        for part in parts:
            try:
                os.mkdir(part, mode=0o700, dir_fd=parent_fd)
                os.fsync(parent_fd)
            except FileExistsError:
                pass
            next_fd = openat2(
                parent_fd,
                part,
                os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC | os.O_NOFOLLOW,
            )
            os.close(parent_fd)
            parent_fd = next_fd
        os.fsync(parent_fd)
        return {"created": True, "components": len(parts)}
    finally:
        os.close(parent_fd)


def initialize(request):
    if ROOTS:
        raise ValueError("broker roots are immutable after initialization")
    roots = request.get("roots")
    if not isinstance(roots, list) or not roots:
        raise ValueError("broker requires at least one root")
    opened = []
    try:
        for item in roots:
            root_id = item.get("id") if isinstance(item, dict) else None
            root_path = item.get("path") if isinstance(item, dict) else None
            if (
                not isinstance(root_id, str)
                or not root_id
                or root_id in ROOTS
                or not isinstance(root_path, str)
                or not os.path.isabs(root_path)
            ):
                raise ValueError("invalid broker root")
            exact_files = write_files(item)
            fd = os.open(
                root_path,
                os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC | os.O_NOFOLLOW,
            )
            info = os.fstat(fd)
            if not stat.S_ISDIR(info.st_mode):
                os.close(fd)
                raise ValueError("broker root must be a real directory")
            ROOTS[root_id] = {"fd": fd, "write": item.get("write") is True, "writeFiles": exact_files}
            opened.append(fd)
        if any(root['writeFiles'] is not None for root in ROOTS.values()) and any(
                root['write'] and root['writeFiles'] is None for root in ROOTS.values()):
            raise ValueError("closing file manifests cannot coexist with unrestricted writable roots")
        return {"rootIds": sorted(ROOTS.keys()), "openat2": True}
    except Exception:
        for fd in opened:
            os.close(fd)
        ROOTS.clear()
        raise


def dispatch(request):
    action = request.get("action")
    if action == "initialize":
        return initialize(request)
    if action == "read":
        return read_file(request)
    if action == "write":
        return write_file(request)
    if action == "remove":
        return remove_file(request)
    if action == "list":
        return list_directory(request)
    if action == "mkdir":
        return make_directory(request)
    if action == "matrix":
        return {
            "rootIds": sorted(ROOTS.keys()),
            "closingFiles": {key: sorted(value['writeFiles']) for key, value in ROOTS.items() if value['writeFiles'] is not None},
            "primitive": "openat2",
            "resolve": ["BENEATH", "NO_SYMLINKS", "NO_MAGICLINKS", "NO_XDEV"],
        }
    if action == "close":
        return {"closed": True}
    raise ValueError("unsupported broker action")


def main():
    for raw in sys.stdin:
        try:
            request = json.loads(raw)
            request_id = request.get("id")
            result = dispatch(request)
            response = {"id": request_id, "ok": True, "result": result}
        except Exception as error:
            response = {
                "id": locals().get("request", {}).get("id"),
                "ok": False,
                "error": {"type": type(error).__name__, "message": str(error)},
            }
        sys.stdout.write(json.dumps(response, separators=(",", ":")) + "\n")
        sys.stdout.flush()
        if locals().get("request", {}).get("action") == "close":
            return


if __name__ == "__main__":
    main()
