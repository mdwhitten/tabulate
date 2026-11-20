import { describe, it, expect } from 'vitest'
import { splitNdjson, flushNdjson } from './ndjson'

/** Feed chunks through the splitter the way the stream reader does. */
function runChunks(chunks: string[]): string[] {
  const out: string[] = []
  let rest = ''
  for (const c of chunks) {
    const r = splitNdjson(rest, c)
    out.push(...r.lines)
    rest = r.rest
  }
  out.push(...flushNdjson(rest))
  return out
}

describe('splitNdjson', () => {
  it('returns complete lines and keeps the incomplete remainder', () => {
    expect(splitNdjson('', '{"a":1}\n{"b"')).toEqual({ lines: ['{"a":1}'], rest: '{"b"' })
  })

  it('joins a line split across chunk boundaries', () => {
    expect(runChunks(['{"type":"pro', 'gress","stage":"pre', 'paring"}\n'])).toEqual([
      '{"type":"progress","stage":"preparing"}',
    ])
  })

  it('handles multiple lines in a single chunk', () => {
    expect(runChunks(['{"a":1}\n{"b":2}\n{"c":3}\n'])).toEqual(['{"a":1}', '{"b":2}', '{"c":3}'])
  })

  it('splits when the newline itself starts the next chunk', () => {
    expect(runChunks(['{"a":1}', '\n{"b":2}', '\n'])).toEqual(['{"a":1}', '{"b":2}'])
  })

  it('emits a trailing line without a newline on flush', () => {
    expect(runChunks(['{"a":1}\n{"b":2}'])).toEqual(['{"a":1}', '{"b":2}'])
  })

  it('drops blank and whitespace-only lines and tolerates CRLF', () => {
    expect(runChunks(['\n{"a":1}\r\n\r\n', '   \n{"b":2}\n\n'])).toEqual(['{"a":1}', '{"b":2}'])
  })

  it('returns nothing for empty input', () => {
    expect(runChunks([''])).toEqual([])
    expect(flushNdjson('   ')).toEqual([])
  })
})
