import React, { useMemo } from 'react'

interface DiffLine {
  type: 'add' | 'remove' | 'same'
  text: string
  oldLineNumber?: number
  newLineNumber?: number
}

// Compute LCS table for line-based diff
function computeLCS(oldLines: string[], newLines: string[]): number[][] {
  const m = oldLines.length
  const n = newLines.length
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0))

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (oldLines[i - 1] === newLines[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1])
      }
    }
  }

  return dp
}

function generateLineDiff(oldText: string, newText: string): { lines: DiffLine[]; additions: number; deletions: number } {
  const oldLines = oldText ? oldText.split('\n') : []
  const newLines = newText ? newText.split('\n') : []

  const dp = computeLCS(oldLines, newLines)
  const diff: DiffLine[] = []

  let i = oldLines.length
  let j = newLines.length
  let additions = 0
  let deletions = 0

  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && oldLines[i - 1] === newLines[j - 1]) {
      diff.unshift({
        type: 'same',
        text: oldLines[i - 1],
        oldLineNumber: i,
        newLineNumber: j
      })
      i--
      j--
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      diff.unshift({
        type: 'add',
        text: newLines[j - 1],
        newLineNumber: j
      })
      additions++
      j--
    } else if (i > 0 && (j === 0 || dp[i][j - 1] < dp[i - 1][j])) {
      diff.unshift({
        type: 'remove',
        text: oldLines[i - 1],
        oldLineNumber: i
      })
      deletions++
      i--
    }
  }

  return { lines: diff, additions, deletions }
}

interface DiffPreviewProps {
  oldContent: string
  newContent: string
}

export const DiffPreview: React.FC<DiffPreviewProps> = ({ oldContent, newContent }) => {
  const { lines, additions, deletions } = useMemo(() => {
    return generateLineDiff(oldContent, newContent)
  }, [oldContent, newContent])

  return (
    <div className="diff-preview-container">
      <div className="diff-header-bar">
        <span className="diff-stats-badge additions">+{additions}</span>
        <span className="diff-stats-badge deletions">-{deletions}</span>
        <span className="diff-stats-label">{lines.length} total lines</span>
      </div>
      <div className="diff-lines-wrapper">
        {lines.map((line, idx) => (
          <div key={idx} className={`diff-line ${line.type}`}>
            <span className="diff-line-number old">{line.oldLineNumber || ''}</span>
            <span className="diff-line-number new">{line.newLineNumber || ''}</span>
            <span className="diff-line-prefix">
              {line.type === 'add' ? '+' : line.type === 'remove' ? '-' : ' '}
            </span>
            <span className="diff-line-text">{line.text || ' '}</span>
          </div>
        ))}
      </div>
    </div>
  )
}
