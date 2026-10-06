/**
 * TerminalRingBuffer
 *
 * A high-performance, bounded circular buffer for terminal output.
 * Retains the most recent N characters/bytes of output using an amortized O(1)
 * chunk-queue structure with sliding head pointer and automatic compaction,
 * avoiding O(N^2) string reallocations during high-volume terminal streams.
 */

export class TerminalRingBuffer {
  private capacity: number
  private chunks: string[] = []
  private totalSize: number = 0
  private headIndex: number = 0
  private evictedBytes: number = 0

  constructor(capacity: number = 65536) {
    this.capacity = Math.max(1024, capacity)
  }

  /**
   * Appends an output chunk to the ring buffer in amortized O(1) time.
   * If the buffer capacity is exceeded, oldest chunks from the head are evicted.
   */
  public write(chunk: string): void {
    if (!chunk || chunk.length === 0) return

    // If chunk itself exceeds capacity, keep only the latest tail of size capacity
    if (chunk.length >= this.capacity) {
      this.clear()
      const kept = chunk.slice(chunk.length - this.capacity)
      this.chunks = [kept]
      this.headIndex = 0
      this.totalSize = kept.length
      this.evictedBytes += chunk.length - this.capacity
      return
    }

    this.chunks.push(chunk)
    this.totalSize += chunk.length

    // Evict oldest chunks from head while totalSize > capacity
    while (this.totalSize > this.capacity && this.headIndex < this.chunks.length) {
      const excess = this.totalSize - this.capacity
      const headChunk = this.chunks[this.headIndex]

      if (headChunk.length <= excess) {
        // Drop the whole head chunk
        this.totalSize -= headChunk.length
        this.evictedBytes += headChunk.length
        this.headIndex++
      } else {
        // Partially trim head chunk to exact boundary
        this.chunks[this.headIndex] = headChunk.slice(excess)
        this.totalSize -= excess
        this.evictedBytes += excess
        break
      }
    }

    // Periodic compaction to prevent memory leaks from dangling head array slots
    if (this.headIndex > 128 && this.headIndex > (this.chunks.length >> 1)) {
      this.chunks = this.chunks.slice(this.headIndex)
      this.headIndex = 0
    }
  }

  /**
   * Returns the contiguous string of all retained buffer content.
   */
  public toString(): string {
    if (this.headIndex > 0) {
      this.chunks = this.chunks.slice(this.headIndex)
      this.headIndex = 0
    }
    return this.chunks.join('')
  }

  /**
   * Returns the current character size of retained output in the buffer.
   */
  public size(): number {
    return this.totalSize
  }

  /**
   * Returns the maximum capacity of the ring buffer.
   */
  public getCapacity(): number {
    return this.capacity
  }

  /**
   * Returns the total number of bytes/characters evicted over the buffer's lifetime.
   */
  public getEvictedBytes(): number {
    return this.evictedBytes
  }

  /**
   * Clears all stored chunks and resets size.
   */
  public clear(): void {
    this.chunks = []
    this.totalSize = 0
    this.headIndex = 0
  }
}
