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

/**
 * Extract the JSON payload from one line of the upload stream.
 *
 * The server sends server-sent events (`data: {...}` lines separated by blank
 * lines); plain NDJSON lines are accepted too. Returns null for lines that
 * carry no payload: SSE comments (`: ...`) and other SSE fields
 * (`event:`, `id:`, `retry:`).
 */
export function eventPayload(line: string): string | null {
  if (line.startsWith(':')) return null
  if (line.startsWith('data:')) {
    const rest = line.slice(5)
    return rest.startsWith(' ') ? rest.slice(1) : rest
  }
  if (/^(event|id|retry):/.test(line)) return null
  return line
}
