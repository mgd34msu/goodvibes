/**
 * unix-peer-socket.ts, the few calls of the C library the daemon's program socket needs that the runtime does not
 * give (daemon/program-socket.ts): a Unix stream socket it listens on, the kernel's word on who connected (the peer's
 * process, user and a process handle, `SO_PEERCRED` / `SO_PEERPIDFD`), the sender of each message (`SO_PASSCRED`,
 * `SCM_CREDENTIALS`, filled in by the kernel for the process that wrote it) and a wait on several descriptors at once
 * (`poll`, never blocking: every call is made with a zero timeout from the daemon's own step).
 *
 * Linux on a 64-bit machine only (the structure layouts below are those of x86-64 and arm64); `openUnixPeerCalls`
 * answers undefined anywhere else, and the caller then issues no registration (nothing fails open).
 */
import { dlopen, FFIType, ptr } from 'bun:ffi';
import { shortSocketPath } from '../utils/short-socket-path.js';

const AF_UNIX = 1;
const SOCK_STREAM = 1;
const SOCK_NONBLOCK = 0o4000;
const SOCK_CLOEXEC = 0o2000000;
const SOL_SOCKET = 1;
const SO_PASSCRED = 16;
const SO_PEERCRED = 17;
const SO_PEERPIDFD = 77;
const SCM_CREDENTIALS = 2;
const MSG_DONTWAIT = 0x40;
const MSG_NOSIGNAL = 0x4000;
const SYS_PIDFD_OPEN = 434;
const PIDFD_NONBLOCK = 0o4000;
export const POLLIN = 0x1;
export const POLLERR = 0x8;
export const POLLHUP = 0x10;
export const POLLNVAL = 0x20;
export const POLLRDHUP = 0x2000;

/** The kernel's word on a connected peer: its process, user and group as they were when it connected. */
export interface PeerCredentials {
  readonly pid: number;
  readonly uid: number;
  readonly gid: number;
}

/** What one read returned: the bytes, and the credentials the kernel attached for the process that wrote them. */
export interface ReceivedMessage {
  /** 0: the peer closed its end. */
  readonly length: number;
  readonly bytes: Uint8Array;
  readonly sender?: PeerCredentials | undefined;
}

export interface UnixPeerCalls {
  /** A listening, non-blocking socket bound at `path` (under 108 bytes); the descriptor, or undefined. */
  listen(path: string, backlog: number): number | undefined;
  /** One waiting connection, non-blocking and closed on exec; undefined when none waits. */
  accept(listener: number): number | undefined;
  peerCredentials(fd: number): PeerCredentials | undefined;
  /** A handle on the connected peer's process from the kernel (`SO_PEERPIDFD`), else one opened on its number. */
  peerProcessHandle(fd: number, pid: number): number | undefined;
  /** Ask the kernel to attach the sender's credentials to every message read from `fd`. */
  passCredentials(fd: number): boolean;
  receive(fd: number, max: number): ReceivedMessage | undefined;
  /** Bytes written (all, or fewer when the peer's buffer is full), or undefined on a failure. */
  send(fd: number, bytes: Uint8Array): number | undefined;
  close(fd: number): void;
  /** The ready events of each descriptor, waited on with a zero timeout; undefined on a failure. */
  poll(entries: readonly { readonly fd: number; readonly events: number }[]): number[] | undefined;
  effectiveUser(): number;
}

let opened: UnixPeerCalls | null | undefined;

/** The calls, opened once per process; undefined where they cannot be (another system, a 32-bit machine, no C library). */
export function openUnixPeerCalls(): UnixPeerCalls | undefined {
  if (opened !== undefined) return opened ?? undefined;
  opened = null;
  if (process.platform !== 'linux' || (process.arch !== 'x64' && process.arch !== 'arm64')) return undefined;
  for (const library of ['libc.so.6', 'libc.so', 'libc.musl-x86_64.so.1', 'libc.musl-aarch64.so.1']) {
    try {
      opened = bind(library);
      return opened;
    } catch {
      // Not this library's name here: try the next.
    }
  }
  return undefined;
}

function bind(library: string): UnixPeerCalls {
  const { i32, u32, u64, i64_fast, ptr: pointer } = FFIType;
  const libc = dlopen(library, {
    socket: { args: [i32, i32, i32], returns: i32 },
    bind: { args: [i32, pointer, u32], returns: i32 },
    listen: { args: [i32, i32], returns: i32 },
    accept4: { args: [i32, pointer, pointer, i32], returns: i32 },
    getsockopt: { args: [i32, i32, i32, pointer, pointer], returns: i32 },
    setsockopt: { args: [i32, i32, i32, pointer, u32], returns: i32 },
    recvmsg: { args: [i32, pointer, i32], returns: i64_fast },
    send: { args: [i32, pointer, u64, i32], returns: i64_fast },
    close: { args: [i32], returns: i32 },
    poll: { args: [pointer, u64, i32], returns: i32 },
    syscall: { args: [i64_fast, i64_fast, i64_fast], returns: i64_fast },
    geteuid: { args: [], returns: u32 },
  }).symbols;
  const int32 = (value: number): Uint8Array => { const bytes = new Uint8Array(4); new DataView(bytes.buffer).setInt32(0, value, true); return bytes; };
  return {
    listen(path, backlog) {
      // A socket's address holds at most 107 bytes: a longer path is bound through this process's own handle on its
      // folder (/proc/self/fd/<n>/<name>), which names the same place.
      const short = shortSocketPath(path);
      const name = new TextEncoder().encode(short.path);
      if (name.length >= 108) { short.release(); return undefined; }
      const fd = libc.socket(AF_UNIX, SOCK_STREAM | SOCK_NONBLOCK | SOCK_CLOEXEC, 0);
      if (fd < 0) return undefined;
      const address = new Uint8Array(110);
      new DataView(address.buffer).setUint16(0, AF_UNIX, true);
      address.set(name, 2);
      const bound = libc.bind(fd, ptr(address), 2 + name.length + 1) === 0 && libc.listen(fd, backlog) === 0;
      short.release();
      if (!bound) {
        libc.close(fd);
        return undefined;
      }
      return fd;
    },
    accept(listener) {
      const fd = libc.accept4(listener, null, null, SOCK_NONBLOCK | SOCK_CLOEXEC);
      return fd >= 0 ? fd : undefined;
    },
    peerCredentials(fd) {
      const value = new Uint8Array(12);
      const length = int32(12);
      if (libc.getsockopt(fd, SOL_SOCKET, SO_PEERCRED, ptr(value), ptr(length)) !== 0) return undefined;
      const view = new DataView(value.buffer);
      return { pid: view.getInt32(0, true), uid: view.getUint32(4, true), gid: view.getUint32(8, true) };
    },
    peerProcessHandle(fd, pid) {
      const value = int32(-1);
      const length = int32(4);
      if (libc.getsockopt(fd, SOL_SOCKET, SO_PEERPIDFD, ptr(value), ptr(length)) === 0) {
        const handle = new DataView(value.buffer).getInt32(0, true);
        if (handle >= 0) return handle;
      }
      // An older kernel (before 6.5): a handle opened on the number. The peer's own answer is checked against the same
      // number afterwards (the kernel's credentials on its message), so a number reused meanwhile proves nothing.
      const handle = Number(libc.syscall(SYS_PIDFD_OPEN, pid, PIDFD_NONBLOCK));
      return handle >= 0 ? handle : undefined;
    },
    passCredentials(fd) {
      return libc.setsockopt(fd, SOL_SOCKET, SO_PASSCRED, ptr(int32(1)), 4) === 0;
    },
    receive(fd, max) {
      const data = new Uint8Array(max);
      const control = new Uint8Array(64);
      const iov = new Uint8Array(16);
      const iovView = new DataView(iov.buffer);
      iovView.setBigUint64(0, BigInt(ptr(data)), true);
      iovView.setBigUint64(8, BigInt(max), true);
      // struct msghdr: name, namelen (+pad), iov, iovlen, control, controllen, flags (+pad).
      const header = new Uint8Array(56);
      const view = new DataView(header.buffer);
      view.setBigUint64(16, BigInt(ptr(iov)), true);
      view.setBigUint64(24, 1n, true);
      view.setBigUint64(32, BigInt(ptr(control)), true);
      view.setBigUint64(40, BigInt(control.length), true);
      const got = Number(libc.recvmsg(fd, ptr(header), MSG_DONTWAIT));
      if (got < 0) return undefined;
      const controlLength = Number(view.getBigUint64(40, true));
      const controlView = new DataView(control.buffer);
      let sender: PeerCredentials | undefined;
      for (let at = 0; at + 16 <= controlLength;) {
        const length = Number(controlView.getBigUint64(at, true));
        if (length < 16) break;
        if (controlView.getInt32(at + 8, true) === SOL_SOCKET && controlView.getInt32(at + 12, true) === SCM_CREDENTIALS && length >= 28) {
          sender = { pid: controlView.getInt32(at + 16, true), uid: controlView.getUint32(at + 20, true), gid: controlView.getUint32(at + 24, true) };
        }
        at += (length + 7) & ~7;
      }
      return { length: got, bytes: data.subarray(0, got), sender };
    },
    send(fd, bytes) {
      if (bytes.length === 0) return 0;
      const sent = Number(libc.send(fd, ptr(bytes), bytes.length, MSG_DONTWAIT | MSG_NOSIGNAL));
      return sent >= 0 ? sent : undefined;
    },
    close(fd) {
      libc.close(fd);
    },
    poll(entries) {
      if (entries.length === 0) return [];
      const table = new Uint8Array(entries.length * 8);
      const view = new DataView(table.buffer);
      entries.forEach((entry, index) => { view.setInt32(index * 8, entry.fd, true); view.setInt16(index * 8 + 4, entry.events, true); });
      if (libc.poll(ptr(table), entries.length, 0) < 0) return undefined;
      return entries.map((_entry, index) => view.getInt16(index * 8 + 6, true) & 0xffff);
    },
    effectiveUser() {
      return libc.geteuid();
    },
  };
}
