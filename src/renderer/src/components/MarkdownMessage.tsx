import React, { useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { Copy, Check, Terminal } from 'lucide-react'

interface CodeBlockProps {
  language?: string
  children: string
}

export const CodeBlock: React.FC<CodeBlockProps> = ({ language, children }) => {
  const [copied, setCopied] = useState(false)

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(children)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch (err) {
      console.error('Failed to copy code:', err)
    }
  }

  const cleanLang = language ? language.replace(/^language-/, '').toLowerCase() : ''

  return (
    <div className="ai-code-block">
      <div className="ai-code-header">
        <div className="ai-code-header-left">
          <Terminal size={12} className="ai-code-icon" />
          <span className="ai-code-lang">{cleanLang || 'code'}</span>
        </div>
        <button
          className="ai-code-copy-btn"
          onClick={handleCopy}
          title="Copy code to clipboard"
          type="button"
        >
          {copied ? (
            <>
              <Check size={12} color="#10b981" />
              <span>Copied</span>
            </>
          ) : (
            <>
              <Copy size={12} />
              <span>Copy</span>
            </>
          )}
        </button>
      </div>
      <pre className="ai-code-content">
        <code>{children}</code>
      </pre>
    </div>
  )
}

interface MarkdownMessageProps {
  content: string
}

export const MarkdownMessage: React.FC<MarkdownMessageProps> = ({ content }) => {
  return (
    <div className="markdown-body">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          code({ className, children, ...props }) {
            const match = /language-(\w+)/.exec(className || '')
            const codeString = String(children).replace(/\n$/, '')
            const isInline = !match && !String(children).includes('\n')

            if (isInline) {
              return (
                <code className="inline-code" {...props}>
                  {children}
                </code>
              )
            }

            return (
              <CodeBlock language={match ? match[1] : undefined}>
                {codeString}
              </CodeBlock>
            )
          },
          a({ href, children }) {
            return (
              <a
                href={href}
                target="_blank"
                rel="noopener noreferrer"
                className="markdown-link"
              >
                {children}
              </a>
            )
          },
          table({ children }) {
            return (
              <div className="markdown-table-wrapper">
                <table className="markdown-table">{children}</table>
              </div>
            )
          },
          th({ children }) {
            return <th className="markdown-th">{children}</th>
          },
          td({ children }) {
            return <td className="markdown-td">{children}</td>
          },
          blockquote({ children }) {
            return <blockquote className="markdown-blockquote">{children}</blockquote>
          }
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  )
}
