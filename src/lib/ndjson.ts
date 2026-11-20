/**
 * Incremental NDJSON (newline-delimited JSON) line splitting.
 *
 * Network chunks don't respect line boundaries: one chunk may hold several
 * lines, and a line may be split across chunks. Feed each decoded chunk to
 * `splitNdjson` together with the carried-over remainder; it returns the
 * complete lines plus the new (incomplete) remainder. When the stream ends,
 * call `flushNdjson` on the remainder to pick up a final line that had no
 * trailing newline.
 *
 * Blank / whitespace-only lines are dropped; `\r\n` endings are tolerated.
 */
export function splitNdjson(rest: string, chunk: string): { lines: string[]; rest: string } {
  const parts = (rest + chunk).split('\n')
  const remainder = parts.pop() ?? ''
  return { lines: parts.map(l => l.trim()).filter(Boolean), rest: remainder }
}

/** Returns the final buffered line (if any) once the stream has ended. */
export function flushNdjson(rest: string): string[] {
  const line = rest.trim()
  return line ? [line] : []
}
