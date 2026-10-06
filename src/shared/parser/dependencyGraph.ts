/**
 * Deterministic Workspace Dependency Graph (Phase 11.6)
 *
 * Tracks direct dependency and dependent relationships between workspace files.
 * Prevents duplicate edges and guarantees consistent ordering.
 */

import { DependencyEdge } from './repoMapTypes'
import { normalizeWorkspacePath } from './moduleResolver'

export class DependencyGraph {
  private edges: DependencyEdge[] = []
  private edgeSet: Set<string> = new Set()
  private fromMap: Map<string, DependencyEdge[]> = new Map()
  private toMap: Map<string, DependencyEdge[]> = new Map()
  private nodeSet: Set<string> = new Set()
  private version: number = 0

  /**
   * Returns current monotonic version of the graph structure.
   * Increments on edge additions, deletions, or clears.
   */
  getVersion(): number {
    return this.version
  }

  /**
   * Returns all unique file nodes present in the dependency graph.
   */
  getNodes(): string[] {
    return Array.from(this.nodeSet).sort()
  }

  private makeEdgeKey(edge: DependencyEdge): string {
    return `${edge.from}-->${edge.to ?? 'EXTERNAL'}:::${edge.specifier}:::${edge.kind}`
  }

  /**
   * Adds a dependency edge between files deterministically.
   * Duplicate edges are ignored.
   */
  addEdge(edge: DependencyEdge): void {
    const normFrom = normalizeWorkspacePath(edge.from)
    if (!normFrom) return

    const normTo = edge.to ? normalizeWorkspacePath(edge.to) : null

    const normalizedEdge: DependencyEdge = {
      ...edge,
      from: normFrom,
      to: normTo
    }

    const key = this.makeEdgeKey(normalizedEdge)
    if (this.edgeSet.has(key)) {
      return
    }

    this.edgeSet.add(key)
    this.edges.push(normalizedEdge)
    this.version++

    this.nodeSet.add(normFrom)
    if (normTo) {
      this.nodeSet.add(normTo)
    }

    // Add to fromMap
    if (!this.fromMap.has(normFrom)) {
      this.fromMap.set(normFrom, [])
    }
    this.fromMap.get(normFrom)!.push(normalizedEdge)

    // Add to toMap (only if resolved to a workspace file)
    if (normTo) {
      if (!this.toMap.has(normTo)) {
        this.toMap.set(normTo, [])
      }
      this.toMap.get(normTo)!.push(normalizedEdge)
    }
  }

  /**
   * Removes all edges associated with a given file (both incoming and outgoing).
   */
  removeFile(filePath: string): void {
    const norm = normalizeWorkspacePath(filePath)
    if (!norm) return

    this.nodeSet.delete(norm)
    this.fromMap.delete(norm)
    this.toMap.delete(norm)

    // Filter edges list and edgeSet
    this.edges = this.edges.filter((e) => {
      const isMatch = e.from === norm || e.to === norm
      if (isMatch) {
        this.edgeSet.delete(this.makeEdgeKey(e))
        // If it was to another file, remove from that file's toMap
        if (e.to && e.to !== norm) {
          const incoming = this.toMap.get(e.to)
          if (incoming) {
            this.toMap.set(
              e.to,
              incoming.filter((inc) => inc.from !== norm)
            )
          }
        }
        // If it was from another file, remove from that file's fromMap
        if (e.from !== norm) {
          const outgoing = this.fromMap.get(e.from)
          if (outgoing) {
            this.fromMap.set(
              e.from,
              outgoing.filter((out) => out.to !== norm)
            )
          }
        }
      }
      return !isMatch
    })
    this.version++
  }

  /**
   * Returns all outgoing dependencies for a file (files imported by `filePath`).
   * Deterministically sorted.
   */
  getDependencies(filePath: string): DependencyEdge[] {
    const norm = normalizeWorkspacePath(filePath)
    if (!norm) return []

    const list = this.fromMap.get(norm) || []
    return [...list].sort((a, b) => {
      const toA = a.to ?? a.specifier
      const toB = b.to ?? b.specifier
      return toA.localeCompare(toB) || a.line - b.line
    })
  }

  /**
   * Returns all incoming dependents for a file (files that import `filePath`).
   * Deterministically sorted.
   */
  getDependents(filePath: string): DependencyEdge[] {
    const norm = normalizeWorkspacePath(filePath)
    if (!norm) return []

    const list = this.toMap.get(norm) || []
    return [...list].sort((a, b) => a.from.localeCompare(b.from) || a.line - b.line)
  }

  /**
   * Returns all dependency edges in the graph, deterministically ordered.
   */
  getEdges(): DependencyEdge[] {
    return [...this.edges].sort((a, b) => {
      const fromDiff = a.from.localeCompare(b.from)
      if (fromDiff !== 0) return fromDiff
      const toA = a.to ?? a.specifier
      const toB = b.to ?? b.specifier
      const toDiff = toA.localeCompare(toB)
      if (toDiff !== 0) return toDiff
      return a.line - b.line
    })
  }

  /**
   * Returns total count of distinct files (nodes) in the graph.
   */
  getNodeCount(): number {
    return this.nodeSet.size
  }

  /**
   * Returns total count of unique dependency edges.
   */
  getEdgeCount(): number {
    return this.edges.length
  }

  /**
   * Clears the graph completely.
   */
  clear(): void {
    this.edges = []
    this.edgeSet.clear()
    this.fromMap.clear()
    this.toMap.clear()
    this.nodeSet.clear()
    this.version++
  }
}
