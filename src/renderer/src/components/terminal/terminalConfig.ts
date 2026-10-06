import type { ITerminalOptions, ITheme } from '@xterm/xterm'

/**
 * High-contrast dark theme matching the AI IDE design tokens
 */
export const XTERM_DARK_THEME: ITheme = {
  background: '#0b0f17',
  foreground: '#cbd5e1',
  cursor: '#38bdf8',
  cursorAccent: '#0b0f17',
  selectionBackground: 'rgba(56, 189, 248, 0.28)',
  selectionForeground: '#f8fafc',
  selectionInactiveBackground: 'rgba(56, 189, 248, 0.14)',
  black: '#1f2026',
  red: '#ef4444',
  green: '#10b981',
  yellow: '#f59e0b',
  blue: '#3b82f6',
  magenta: '#a855f7',
  cyan: '#06b6d4',
  white: '#cbd5e1',
  brightBlack: '#64748b',
  brightRed: '#f87171',
  brightGreen: '#34d399',
  brightYellow: '#fbbf24',
  brightBlue: '#60a5fa',
  brightMagenta: '#c084fc',
  brightCyan: '#38bdf8',
  brightWhite: '#f8fafc'
}

/**
 * Standard developer terminal configuration
 */
export const DEFAULT_XTERM_OPTIONS: ITerminalOptions = {
  cursorBlink: true,
  cursorStyle: 'block',
  fontSize: 12,
  fontFamily: "'Cascadia Code', 'Fira Code', Consolas, 'Courier New', monospace",
  lineHeight: 1.25,
  scrollback: 5000,
  convertEol: true,
  allowTransparency: true,
  theme: XTERM_DARK_THEME
}
