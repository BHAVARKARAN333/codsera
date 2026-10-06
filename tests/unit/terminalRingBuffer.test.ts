import { describe, it, expect } from 'vitest'
import { TerminalRingBuffer } from '../../src/shared/terminalRingBuffer'

describe('TerminalRingBuffer Unit Tests', () => {
  it('1. initializes with bounded capacity of at least 1024 bytes', () => {
    const bufSmall = new TerminalRingBuffer(100)
    expect(bufSmall.getCapacity()).toBe(1024)
    expect(bufSmall.size()).toBe(0)
    expect(bufSmall.toString()).toBe('')
    expect(bufSmall.getEvictedBytes()).toBe(0)

    const bufDefault = new TerminalRingBuffer()
    expect(bufDefault.getCapacity()).toBe(65536)
  })

  it('2. writes chunks and retains contiguous string when within capacity', () => {
    const buf = new TerminalRingBuffer(2048)
    buf.write('Hello, ')
    buf.write('world!')
    buf.write('\n')

    expect(buf.size()).toBe(14)
    expect(buf.toString()).toBe('Hello, world!\n')
    expect(buf.getEvictedBytes()).toBe(0)
  })

  it('3. evicts oldest chunks and characters from head when capacity is exceeded', () => {
    const buf = new TerminalRingBuffer(1024)
    // Write 800 bytes
    const chunkA = 'A'.repeat(800)
    buf.write(chunkA)
    expect(buf.size()).toBe(800)
    expect(buf.getEvictedBytes()).toBe(0)

    // Write another 400 bytes, total 1200 bytes -> exceeds 1024 by 176 bytes
    const chunkB = 'B'.repeat(400)
    buf.write(chunkB)

    expect(buf.size()).toBe(1024)
    expect(buf.getEvictedBytes()).toBe(176)

    const result = buf.toString()
    expect(result.length).toBe(1024)
    // The first 176 'A's should be evicted, leaving 800 - 176 = 624 'A's followed by 400 'B's
    expect(result).toBe('A'.repeat(624) + 'B'.repeat(400))
  })

  it('4. handles chunks larger than the total capacity gracefully', () => {
    const buf = new TerminalRingBuffer(1024)
    const giantChunk = 'X'.repeat(3000)
    buf.write(giantChunk)

    expect(buf.size()).toBe(1024)
    expect(buf.getEvictedBytes()).toBe(1976)
    expect(buf.toString()).toBe('X'.repeat(1024))
  })

  it('5. ignores empty or zero-length chunks', () => {
    const buf = new TerminalRingBuffer(1024)
    buf.write('hello')
    buf.write('')
    buf.write((null as unknown) as string)
    buf.write((undefined as unknown) as string)

    expect(buf.size()).toBe(5)
    expect(buf.toString()).toBe('hello')
  })

  it('6. clears all contents and resets counters', () => {
    const buf = new TerminalRingBuffer(1024)
    buf.write('test data')
    expect(buf.size()).toBe(9)

    buf.clear()
    expect(buf.size()).toBe(0)
    expect(buf.toString()).toBe('')
  })

  it('7. compacts head array during high volume streams without memory bloat', () => {
    const buf = new TerminalRingBuffer(1024)
    // Write 500 small 100-character chunks
    for (let i = 0; i < 500; i++) {
      buf.write(`line ${i.toString().padStart(6, '0')}\n`)
    }

    expect(buf.size()).toBeLessThanOrEqual(1024)
    const str = buf.toString()
    expect(str.length).toBeLessThanOrEqual(1024)
    expect(str).toContain('line 000499')
  })
})
