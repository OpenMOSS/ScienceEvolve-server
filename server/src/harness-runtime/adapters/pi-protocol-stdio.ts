/** Pi's RPC writer emits complete JSONL strings without awaiting stdout drain.
 * A slow trusted consumer otherwise leaves cumulative message snapshots in
 * Node's unbounded writable queue. Linux's native pipe handle supports blocking
 * writes: retain the exact protocol bytes and propagate pressure to the producer.
 * This runs only inside the selected Pi extension, never in the server process.
 */
export function enablePiProtocolBackpressure(): void {
  if (process.platform !== "linux") return;
  const stream = process.stdout as NodeJS.WriteStream & {
    _handle?: { setBlocking?: (blocking: boolean) => void };
  };
  stream._handle?.setBlocking?.(true);
}
