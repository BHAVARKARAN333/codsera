import React, { useState, useEffect, useRef } from 'react'
import {
  Send,
  Sparkles,
  Settings,
  PlusCircle,
  CheckCircle2,
  AlertCircle,
  AlertTriangle,
  Loader2,
  Square,
  ChevronDown,
  ChevronRight,
  FolderTree,
  FileCode,
  FilePlus,
  FileEdit,
  Terminal as TerminalIcon,
  GitBranch,
  FileDiff,
  History,
  Key,
  Copy,
  Check,
  X,
  Eye,
  EyeOff,
  Cpu
} from 'lucide-react'
import { providerRegistry } from '../services/ai/providerRegistry'
import { ListFilesTool } from '../services/tools/listFilesTool'
import { ReadFileTool } from '../services/tools/readFileTool'
import { CreateFileTool } from '../services/tools/createFileTool'
import { EditFileTool } from '../services/tools/editFileTool'
import { RunCommandTool } from '../services/tools/runCommandTool'
import { GitStatusTool } from '../services/tools/gitStatusTool'
import { GitDiffTool } from '../services/tools/gitDiffTool'
import { GitLogTool } from '../services/tools/gitLogTool'
import { AgentOrchestrator, AgentStepEvent } from '../services/agent/orchestrator'
import { MarkdownMessage } from './MarkdownMessage'
import { DiffPreview } from './DiffPreview'
import { AppSettings } from '../../../shared/types'

interface AIChatPanelProps {
  workspaceRoot: string | null
  onFileCreated?: (path: string) => void
  onFileEdited?: (path: string, newContent: string) => void
  onCommandExecuted?: (
    command: string,
    result: { stdout: string; stderr: string; exitCode: number | null }
  ) => void
  onClose?: () => void
}

interface ChatMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  steps?: AgentStepEvent[]
  isError?: boolean
}

type ProviderType = 'gemini' | 'openrouter' | 'nvidia' | 'opencode'

export const AIChatPanel: React.FC<AIChatPanelProps> = ({
  workspaceRoot,
  onFileCreated,
  onFileEdited,
  onCommandExecuted,
  onClose
}) => {
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [inputPrompt, setInputPrompt] = useState('')
  const [providerType, setProviderType] = useState<ProviderType>('gemini')
  const [geminiApiKey, setGeminiApiKey] = useState<string>('')
  const [openRouterApiKey, setOpenRouterApiKey] = useState<string>('')
  const [nvidiaApiKey, setNvidiaApiKey] = useState<string>('')
  const [nvidiaModelId, setNvidiaModelId] = useState<string>('')
  const [opencodeApiKey, setOpencodeApiKey] = useState<string>('')
  const [opencodeModelId, setOpencodeModelId] = useState<string>('space-bunny-free')
  const [showSettings, setShowSettings] = useState<boolean>(false)
  const [showKeyText, setShowKeyText] = useState<boolean>(false)
  const [settingsProviderTab, setSettingsProviderTab] = useState<ProviderType>('gemini')
  const [geminiKeyInput, setGeminiKeyInput] = useState<string>('')
  const [openRouterKeyInput, setOpenRouterKeyInput] = useState<string>('')
  const [nvidiaKeyInput, setNvidiaKeyInput] = useState<string>('')
  const [opencodeKeyInput, setOpencodeKeyInput] = useState<string>('')
  const [geminiKeyCleared, setGeminiKeyCleared] = useState<boolean>(false)
  const [openRouterKeyCleared, setOpenRouterKeyCleared] = useState<boolean>(false)
  const [nvidiaKeyCleared, setNvidiaKeyCleared] = useState<boolean>(false)
  const [opencodeKeyCleared, setOpencodeKeyCleared] = useState<boolean>(false)
  const [nvidiaModelInput, setNvidiaModelInput] = useState<string>('')
  const [opencodeModelInput, setOpencodeModelInput] = useState<string>('space-bunny-free')
  const [availableNvidiaModels, setAvailableNvidiaModels] = useState<Array<{ id: string }>>([])
  const [availableOpencodeModels, setAvailableOpencodeModels] = useState<Array<{ id: string }>>([])
  const [isFetchingModels, setIsFetchingModels] = useState<boolean>(false)
  const [isFetchingOpencodeModels, setIsFetchingOpencodeModels] = useState<boolean>(false)
  const [fetchModelsError, setFetchModelsError] = useState<string | null>(null)
  const [fetchOpencodeModelsError, setFetchOpencodeModelsError] = useState<string | null>(null)
  const [isTestingConnection, setIsTestingConnection] = useState<boolean>(false)
  const [isTestingOpencodeConnection, setIsTestingOpencodeConnection] = useState<boolean>(false)
  const [connectionTestResult, setConnectionTestResult] = useState<{
    success: boolean
    status?: number
    message: string
  } | null>(null)
  const [opencodeConnectionTestResult, setOpencodeConnectionTestResult] = useState<{
    success: boolean
    status?: number
    message: string
  } | null>(null)
  const [isRunning, setIsRunning] = useState<boolean>(false)
  const [currentStep, setCurrentStep] = useState<AgentStepEvent | null>(null)
  const [expandedToolResults, setExpandedToolResults] = useState<Record<string, boolean>>({})
  const [copiedMessageId, setCopiedMessageId] = useState<string | null>(null)
  const [pendingApproval, setPendingApproval] = useState<{
    id: string
    toolName: string
    path: string
    content?: string
    oldContent?: string
    newContent?: string
    command?: string
    isDangerous?: boolean
    resolve: (approved: boolean) => void
  } | null>(null)
  const [showApprovalPreview, setShowApprovalPreview] = useState<boolean>(true)
  const [isApproving, setIsApproving] = useState<boolean>(false)

  const isRunningRef = useRef<boolean>(false)
  const currentRequestIdRef = useRef<string | null>(null)
  const orchestratorRef = useRef<AgentOrchestrator | null>(null)
  const messagesEndRef = useRef<HTMLDivElement>(null)

  const activeApiKey =
    providerType === 'gemini'
      ? geminiApiKey
      : providerType === 'openrouter'
      ? openRouterApiKey
      : providerType === 'nvidia'
      ? nvidiaApiKey
      : opencodeApiKey
  const activeModelName =
    providerType === 'nvidia'
      ? nvidiaModelId.trim()
      : providerType === 'opencode'
      ? opencodeModelId.trim() || 'space-bunny-free'
      : providerRegistry.has(providerType)
      ? providerRegistry.getMetadata(providerType).defaultModel
      : 'gemini-3.8-flash'

  // Initialize orchestrator and load persisted settings & keys
  useEffect(() => {
    const initialProvider = providerRegistry.get('gemini')
    const orchestrator = new AgentOrchestrator(initialProvider)
    orchestrator.registerTool(new ListFilesTool())
    orchestrator.registerTool(new ReadFileTool())
    orchestrator.registerTool(new CreateFileTool())
    orchestrator.registerTool(new EditFileTool())
    orchestrator.registerTool(new RunCommandTool())
    orchestrator.registerTool(new GitStatusTool())
    orchestrator.registerTool(new GitDiffTool())
    orchestrator.registerTool(new GitLogTool())
    orchestratorRef.current = orchestrator

    // Load persisted settings from secure Electron storage
    window.electronAPI
      .getSettings()
      .then(async (settings) => {
        let resolvedGeminiKey = settings.geminiApiKey || ''
        let resolvedOpenRouterKey = settings.openRouterApiKey || ''
        let resolvedNvidiaKey = settings.nvidiaApiKey || ''
        let resolvedOpenCodeKey = settings.opencodeApiKey || ''

        // Fall back to environment variables if not set in persisted settings
        if (!resolvedGeminiKey) {
          const envKey = await window.electronAPI.getEnvApiKey('gemini')
          if (envKey) resolvedGeminiKey = envKey
        }

        if (!resolvedOpenRouterKey) {
          const envKey = await window.electronAPI.getEnvApiKey('openrouter')
          if (envKey) resolvedOpenRouterKey = envKey
        }

        if (!resolvedNvidiaKey) {
          const envKey = await window.electronAPI.getEnvApiKey('nvidia')
          if (envKey) resolvedNvidiaKey = envKey
        }

        if (!resolvedOpenCodeKey) {
          const envKey = await window.electronAPI.getEnvApiKey('opencode')
          if (envKey) resolvedOpenCodeKey = envKey
        }

        setGeminiApiKey(resolvedGeminiKey)
        setOpenRouterApiKey(resolvedOpenRouterKey)
        setNvidiaApiKey(resolvedNvidiaKey)
        setOpencodeApiKey(resolvedOpenCodeKey)

        if (settings.nvidiaModelId) {
          setNvidiaModelId(settings.nvidiaModelId)
        }
        if (settings.opencodeModelId) {
          setOpencodeModelId(settings.opencodeModelId)
          setOpencodeModelInput(settings.opencodeModelId)
        }

        if (
          settings.selectedProvider &&
          providerRegistry.has(settings.selectedProvider)
        ) {
          const pType = settings.selectedProvider as ProviderType
          setProviderType(pType)
          orchestrator.setProvider(providerRegistry.get(pType))
        }
      })
      .catch((err) => {
        console.error('Failed to load settings:', err)
      })

    // Safe development-only debug bridge to enable indexing profiler and inspect smart context diagnostics
    if (import.meta.env.DEV) {
      window.__enableProfiling = (enabled = true) => {
        const engine = orchestrator.getSmartContextEngine()
        engine.enableProfiling(enabled)
        console.log(`[SmartContextEngine] Indexing profiling is now ${enabled ? 'ENABLED' : 'DISABLED'}.`)
        return engine
      }

      window.__getLastSmartContext = () => {
        const engine = orchestrator.getSmartContextEngine()
        return engine.getLastDiagnostics()
      }
    }

    return () => {
      orchestratorRef.current?.stop()
      if (import.meta.env.DEV && typeof window !== 'undefined') {
        delete window.__enableProfiling
        delete window.__getLastSmartContext
      }
    }
  }, [])

  // Trigger workspace indexing whenever workspaceRoot opens or switches
  useEffect(() => {
    if (orchestratorRef.current && workspaceRoot) {
      orchestratorRef.current
        .getSmartContextEngine()
        .initializeWorkspaceIndex(workspaceRoot)
        .catch(() => {})
    }
  }, [workspaceRoot])

  // Listen for real-time filesystem changes (edits, creations, deletions) in workspace
  useEffect(() => {
    if (typeof window === 'undefined' || !window.electronAPI?.onWorkspaceFileChanged) return

    const unsubscribe = window.electronAPI.onWorkspaceFileChanged((event) => {
      if (orchestratorRef.current) {
        orchestratorRef.current.getSmartContextEngine().handleFileEvent(event).catch(() => {})
      }
    })

    return () => {
      unsubscribe()
    }
  }, [])

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, currentStep, isRunning, pendingApproval])

  // Reset conversation when switching providers (Clean session model)
  const handleProviderChange = (newProvider: ProviderType) => {
    if (newProvider === providerType) return
    currentRequestIdRef.current = null
    setProviderType(newProvider)

    // Persist provider selection
    window.electronAPI.saveSettings({ selectedProvider: newProvider }).catch(() => {})

    if (pendingApproval) {
      pendingApproval.resolve(false)
    }

    if (orchestratorRef.current) {
      try {
        const provider = providerRegistry.get(newProvider)
        orchestratorRef.current.setProvider(provider)
        orchestratorRef.current.clearHistory()
      } catch (err: unknown) {
        console.error(`Failed to switch to provider "${newProvider}":`, err)
      }
    }

    setMessages([])
    setCurrentStep(null)
    setPendingApproval(null)
    setShowApprovalPreview(true)
    setIsApproving(false)
    setIsRunning(false)
    isRunningRef.current = false
  }

  // Start new clean chat session
  const handleNewChat = () => {
    currentRequestIdRef.current = null
    if (isRunning) {
      orchestratorRef.current?.stop()
    }
    if (pendingApproval) {
      pendingApproval.resolve(false)
    }
    orchestratorRef.current?.clearHistory()
    setMessages([])
    setCurrentStep(null)
    setPendingApproval(null)
    setShowApprovalPreview(true)
    setIsApproving(false)
    setIsRunning(false)
    isRunningRef.current = false
  }

  // Fetch available models list from NVIDIA NIM API
  const handleFetchNvidiaModels = async () => {
    setIsFetchingModels(true)
    setFetchModelsError(null)
    setConnectionTestResult(null)
    try {
      const activeKey = nvidiaKeyInput.trim() || (!nvidiaKeyCleared ? nvidiaApiKey.trim() : '')
      if (!activeKey) {
        setFetchModelsError('NVIDIA NIM API key is missing. Please enter your API key first.')
        setIsFetchingModels(false)
        return
      }
      const res = await window.electronAPI.nvidiaListModels({ apiKey: activeKey })
      if (res.success && Array.isArray(res.models)) {
        setAvailableNvidiaModels(res.models)
        if (res.models.length > 0) {
          if (!nvidiaModelInput.trim() && !nvidiaModelId.trim()) {
            setNvidiaModelInput(res.models[0].id)
          }
        }
      } else {
        const errorMsg = res.errorDetails || res.error || 'Failed to fetch model list from NVIDIA NIM.'
        setFetchModelsError(errorMsg)
      }
    } catch (err: unknown) {
      const errorMsg = err instanceof Error ? err.message : String(err)
      setFetchModelsError(errorMsg)
    } finally {
      setIsFetchingModels(false)
    }
  }

  // Test connection with selected model
  const handleTestNvidiaConnection = async () => {
    const activeModel = nvidiaModelInput.trim() || nvidiaModelId.trim()
    const activeKey = nvidiaKeyInput.trim() || (!nvidiaKeyCleared ? nvidiaApiKey.trim() : '')

    if (!activeKey) {
      setConnectionTestResult({
        success: false,
        message: 'NVIDIA API key is missing. Please enter or configure your key first.'
      })
      return
    }

    if (!activeModel) {
      setConnectionTestResult({
        success: false,
        message: 'No model selected. Please fetch available models and select one first.'
      })
      return
    }

    setIsTestingConnection(true)
    setConnectionTestResult(null)

    try {
      const res = await window.electronAPI.nvidiaChatCompletion({
        model: activeModel,
        messages: [{ role: 'user', content: 'Say OK' }],
        apiKey: activeKey,
        timeoutMs: 15000
      })

      if (res.success) {
        setConnectionTestResult({
          success: true,
          status: res.status || 200,
          message: `Connection successful (HTTP ${res.status || 200} OK)`
        })
      } else {
        const rawErr = res.errorDetails || res.error || 'Connection test failed'
        setConnectionTestResult({
          success: false,
          status: res.status,
          message: `HTTP ${res.status || 'Error'}: ${rawErr}`
        })
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      setConnectionTestResult({
        success: false,
        message: `Connection failed: ${msg}`
      })
    } finally {
      setIsTestingConnection(false)
    }
  }

  // Fetch available models list from OpenCode API
  const handleFetchOpencodeModels = async () => {
    setIsFetchingOpencodeModels(true)
    setFetchOpencodeModelsError(null)
    setOpencodeConnectionTestResult(null)
    try {
      const activeKey = opencodeKeyInput.trim() || (!opencodeKeyCleared ? opencodeApiKey.trim() : '')
      const res = await window.electronAPI.opencodeListModels({ apiKey: activeKey || undefined })
      if (res.success && Array.isArray(res.models)) {
        setAvailableOpencodeModels(res.models)
        if (res.models.length > 0) {
          if (!opencodeModelInput.trim() && !opencodeModelId.trim()) {
            setOpencodeModelInput(res.models[0].id)
          }
        }
      } else {
        const errorMsg = res.errorDetails || res.error || 'Failed to fetch model list from OpenCode.'
        setFetchOpencodeModelsError(errorMsg)
      }
    } catch (err: unknown) {
      const errorMsg = err instanceof Error ? err.message : String(err)
      setFetchOpencodeModelsError(errorMsg)
    } finally {
      setIsFetchingOpencodeModels(false)
    }
  }

  // Test connection with selected OpenCode model
  const handleTestOpencodeConnection = async () => {
    const activeModel = opencodeModelInput.trim() || opencodeModelId.trim() || 'space-bunny-free'
    const activeKey = opencodeKeyInput.trim() || (!opencodeKeyCleared ? opencodeApiKey.trim() : '')

    setIsTestingOpencodeConnection(true)
    setOpencodeConnectionTestResult(null)

    try {
      const res = await window.electronAPI.opencodeChatCompletion({
        model: activeModel,
        messages: [{ role: 'user', content: 'Say OK' }],
        apiKey: activeKey || undefined,
        timeoutMs: 15000
      })

      if (res.success) {
        setOpencodeConnectionTestResult({
          success: true,
          status: res.status || 200,
          message: `Connection successful (HTTP ${res.status || 200} OK)`
        })
      } else {
        const rawErr = res.errorDetails || res.error || 'Connection test failed'
        setOpencodeConnectionTestResult({
          success: false,
          status: res.status,
          message: `HTTP ${res.status || 'Error'}: ${rawErr}`
        })
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      setOpencodeConnectionTestResult({
        success: false,
        message: `Connection failed: ${msg}`
      })
    } finally {
      setIsTestingOpencodeConnection(false)
    }
  }

  // Open settings dialog
  const handleOpenSettings = (targetTab?: ProviderType) => {
    const tab = targetTab || providerType
    setSettingsProviderTab(tab)
    setGeminiKeyInput('')
    setOpenRouterKeyInput('')
    setNvidiaKeyInput('')
    setOpencodeKeyInput('')
    setGeminiKeyCleared(false)
    setOpenRouterKeyCleared(false)
    setNvidiaKeyCleared(false)
    setOpencodeKeyCleared(false)
    setNvidiaModelInput(nvidiaModelId)
    setOpencodeModelInput(opencodeModelId || 'space-bunny-free')
    setFetchModelsError(null)
    setFetchOpencodeModelsError(null)
    setConnectionTestResult(null)
    setOpencodeConnectionTestResult(null)
    setShowKeyText(false)
    setShowSettings(true)
  }

  // Save API key for selected provider in settings
  const handleSaveSettingsKey = async () => {
    const updates: Partial<AppSettings> = {
      selectedProvider: settingsProviderTab
    }

    if (geminiKeyCleared) {
      setGeminiApiKey('')
      updates.geminiApiKey = ''
    } else if (geminiKeyInput.trim().length > 0) {
      const trimmedKey = geminiKeyInput.trim()
      setGeminiApiKey(trimmedKey)
      updates.geminiApiKey = trimmedKey
    }

    if (openRouterKeyCleared) {
      setOpenRouterApiKey('')
      updates.openRouterApiKey = ''
    } else if (openRouterKeyInput.trim().length > 0) {
      const trimmedKey = openRouterKeyInput.trim()
      setOpenRouterApiKey(trimmedKey)
      updates.openRouterApiKey = trimmedKey
    }

    const trimmedNvidiaModel = nvidiaModelInput.trim()
    setNvidiaModelId(trimmedNvidiaModel)
    updates.nvidiaModelId = trimmedNvidiaModel

    if (nvidiaKeyCleared) {
      setNvidiaApiKey('')
      updates.nvidiaApiKey = ''
    } else if (nvidiaKeyInput.trim().length > 0) {
      const trimmedKey = nvidiaKeyInput.trim()
      setNvidiaApiKey(trimmedKey)
      updates.nvidiaApiKey = trimmedKey
    }

    const trimmedOpencodeModel = opencodeModelInput.trim() || 'space-bunny-free'
    setOpencodeModelId(trimmedOpencodeModel)
    updates.opencodeModelId = trimmedOpencodeModel

    if (opencodeKeyCleared) {
      setOpencodeApiKey('')
      updates.opencodeApiKey = ''
    } else if (opencodeKeyInput.trim().length > 0) {
      const trimmedKey = opencodeKeyInput.trim()
      setOpencodeApiKey(trimmedKey)
      updates.opencodeApiKey = trimmedKey
    }

    try {
      await window.electronAPI.saveSettings(updates)
    } catch (err) {
      console.error('Failed to persist settings:', err)
    }

    setShowSettings(false)
  }

  const handleStop = () => {
    currentRequestIdRef.current = null
    if (isRunning && orchestratorRef.current) {
      orchestratorRef.current.stop()
      if (pendingApproval) {
        pendingApproval.resolve(false)
      }
      setPendingApproval(null)
      setShowApprovalPreview(true)
      setIsApproving(false)
      setIsRunning(false)
      isRunningRef.current = false
      setCurrentStep(null)
    }
  }

  const handleSend = async (customText?: string) => {
    const textToSend = customText || inputPrompt
    if (!textToSend.trim() || isRunningRef.current) return

    let currentApiKey = activeApiKey
    const providerMeta = providerRegistry.has(providerType)
      ? providerRegistry.getMetadata(providerType)
      : null
    const requiresKey = providerMeta?.capabilities.requiresApiKey ?? (providerType !== 'opencode')

    if (!currentApiKey && requiresKey) {
      // Dynamic lookup to prevent any key desync
      try {
        const persisted = await window.electronAPI.getSettings()
        const envKey = await window.electronAPI.getEnvApiKey(providerType)
        if (providerType === 'gemini') {
          currentApiKey = persisted.geminiApiKey || envKey || ''
          if (currentApiKey) setGeminiApiKey(currentApiKey)
        } else if (providerType === 'openrouter') {
          currentApiKey = persisted.openRouterApiKey || envKey || ''
          if (currentApiKey) setOpenRouterApiKey(currentApiKey)
        } else if (providerType === 'nvidia') {
          currentApiKey = persisted.nvidiaApiKey || envKey || ''
          if (currentApiKey) setNvidiaApiKey(currentApiKey)
        }
      } catch {}
    }

    if (!currentApiKey && requiresKey) {
      const providerLabel = providerMeta?.name || providerType
      const missingKeyMsg: ChatMessage = {
        id: crypto.randomUUID(),
        role: 'assistant',
        content: `${providerLabel} API key is not configured. Please add your key in Settings.`,
        isError: true
      }
      setMessages((prev) => [...prev, missingKeyMsg])
      handleOpenSettings(providerType)
      return
    }

    if (providerType === 'nvidia' && !nvidiaModelId.trim()) {
      const missingModelMsg: ChatMessage = {
        id: crypto.randomUUID(),
        role: 'assistant',
        content: 'No NVIDIA NIM model selected. Please open Settings, fetch available models, and select one.',
        isError: true
      }
      setMessages((prev) => [...prev, missingModelMsg])
      handleOpenSettings('nvidia')
      return
    }

    const requestId = crypto.randomUUID()
    currentRequestIdRef.current = requestId
    isRunningRef.current = true
    setIsRunning(true)
    setCurrentStep({ type: 'thinking' })
    setPendingApproval(null)
    setShowApprovalPreview(true)

    const userMessage: ChatMessage = {
      id: requestId,
      role: 'user',
      content: textToSend
    }

    setMessages((prev) => [...prev, userMessage])
    if (!customText) setInputPrompt('')

    const recordedSteps: AgentStepEvent[] = []
    let lastToolResultCount = 0
    let committedContentLength = 0

    try {
      if (!orchestratorRef.current) return

      const finalResponse = await orchestratorRef.current.run(textToSend, {
        apiKey: activeApiKey,
        modelName: activeModelName,
        workspaceRoot,
        requestApproval: (req) => {
          return new Promise<boolean>((resolve) => {
            setPendingApproval({
              id: crypto.randomUUID(),
              toolName: req.toolName,
              path: req.path,
              content: req.content,
              oldContent: req.oldContent,
              newContent: req.newContent,
              command: req.command,
              isDangerous: req.isDangerous,
              resolve: (approved) => {
                resolve(approved)
              }
            })
          })
        },
        onFileCreated: (createdPath) => {
          onFileCreated?.(createdPath)
        },
        onFileEdited: (editedPath, newContent) => {
          onFileEdited?.(editedPath, newContent)
        },
        onCommandExecuted: (cmd, res) => {
          onCommandExecuted?.(cmd, res)
        },
        onChunk: (chunk: string) => {
          if (currentRequestIdRef.current !== requestId || !chunk) return
          setMessages((prev) => {
            const assistantMsgId = `${requestId}-res`
            const existingIdx = prev.findIndex((m) => m.id === assistantMsgId)
            const toolSteps = recordedSteps.filter((s) => s.type === 'tool_result')

            if (existingIdx >= 0) {
              const updated = [...prev]
              let existingContent = updated[existingIdx].content
              if (
                existingContent &&
                toolSteps.length > lastToolResultCount &&
                !existingContent.endsWith('\n') &&
                !chunk.startsWith('\n')
              ) {
                existingContent = `${existingContent}\n\n`
              }
              lastToolResultCount = toolSteps.length
              updated[existingIdx] = {
                ...updated[existingIdx],
                content: existingContent + chunk,
                steps: toolSteps
              }
              return updated
            } else {
              lastToolResultCount = toolSteps.length
              return [
                ...prev,
                {
                  id: assistantMsgId,
                  role: 'assistant',
                  content: chunk,
                  steps: toolSteps
                }
              ]
            }
          })
        },
        onStep: (event) => {
          if (currentRequestIdRef.current !== requestId) return
          recordedSteps.push(event)
          setCurrentStep(event)
          if (event.type === 'retrying') {
            setMessages((prev) => {
              const assistantMsgId = `${requestId}-res`
              const existingIdx = prev.findIndex((m) => m.id === assistantMsgId)
              if (existingIdx >= 0) {
                const updated = [...prev]
                const toolSteps = recordedSteps.filter((s) => s.type === 'tool_result')
                updated[existingIdx] = {
                  ...updated[existingIdx],
                  content: updated[existingIdx].content.slice(0, committedContentLength),
                  steps: toolSteps
                }
                return updated
              }
              return prev
            })
          } else if (event.type === 'tool_result') {
            setMessages((prev) => {
              const assistantMsgId = `${requestId}-res`
              const existingIdx = prev.findIndex((m) => m.id === assistantMsgId)
              const toolSteps = recordedSteps.filter((s) => s.type === 'tool_result')
              if (existingIdx >= 0) {
                const updated = [...prev]
                committedContentLength = updated[existingIdx].content.length
                updated[existingIdx] = {
                  ...updated[existingIdx],
                  steps: toolSteps
                }
                return updated
              } else {
                return [
                  ...prev,
                  {
                    id: assistantMsgId,
                    role: 'assistant',
                    content: '',
                    steps: toolSteps
                  }
                ]
              }
            })
          }
        }
      })

      if (currentRequestIdRef.current === requestId) {
        setMessages((prev) => {
          const assistantMsgId = `${requestId}-res`
          const existingIdx = prev.findIndex((m) => m.id === assistantMsgId)
          const toolSteps = recordedSteps.filter((s) => s.type === 'tool_result')

          if (existingIdx >= 0) {
            const updated = [...prev]
            const existingContent = updated[existingIdx].content

            // Prevent duplicate text when finalResponse is received
            let reconciledContent = existingContent
            if (!existingContent) {
              reconciledContent = finalResponse
            } else if (
              finalResponse &&
              !existingContent.includes(finalResponse) &&
              !finalResponse.includes(existingContent)
            ) {
              reconciledContent = `${existingContent}\n\n${finalResponse}`
            } else if (finalResponse && finalResponse.length > existingContent.length) {
              reconciledContent = finalResponse
            }

            updated[existingIdx] = {
              ...updated[existingIdx],
              content: reconciledContent,
              steps: toolSteps
            }
            return updated
          } else {
            return [
              ...prev,
              {
                id: assistantMsgId,
                role: 'assistant',
                content: finalResponse,
                steps: toolSteps
              }
            ]
          }
        })
      }
    } catch (err: unknown) {
      if (currentRequestIdRef.current === requestId) {
        const errorMessage = err instanceof Error ? err.message : String(err)
        const errorResponse: ChatMessage = {
          id: `${requestId}-err`,
          role: 'assistant',
          content: errorMessage,
          steps: recordedSteps.filter((s) => s.type === 'tool_result'),
          isError: true
        }
        setMessages((prev) => [...prev, errorResponse])
      }
    } finally {
      if (currentRequestIdRef.current === requestId) {
        isRunningRef.current = false
        setIsRunning(false)
        setCurrentStep(null)
      }
    }
  }

  const toggleToolResult = (id: string) => {
    setExpandedToolResults((prev) => ({ ...prev, [id]: !prev[id] }))
  }

  const handleCopyMessage = async (msgId: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text)
      setCopiedMessageId(msgId)
      setTimeout(() => setCopiedMessageId(null), 2000)
    } catch (err) {
      console.error('Failed to copy response:', err)
    }
  }

  return (
    <div className="ai-chat-panel">
      {/* Top Header Bar */}
      <div className="ai-panel-header">
        <div className="ai-header-title">
          <Sparkles size={14} className="ai-sparkle-icon" />
          <span>AI Assistant</span>
        </div>

        <div className="ai-header-actions">
          {/* Provider Select Dropdown */}
          <div className="ai-provider-select-wrapper">
            <select
              className="ai-provider-select"
              value={providerType}
              onChange={(e) => handleProviderChange(e.target.value as ProviderType)}
              disabled={isRunning}
              title="Switch AI Provider"
            >
              <option value="gemini">Gemini</option>
              <option value="openrouter">OpenRouter (Free)</option>
              <option value="nvidia">NVIDIA NIM</option>
              <option value="opencode">OpenCode (Free)</option>
            </select>
          </div>

          {/* Settings Button */}
          <button
            className={`btn-icon ${activeApiKey || providerType === 'opencode' ? 'configured' : 'warning'}`}
            onClick={() => handleOpenSettings()}
            title={activeApiKey || providerType === 'opencode' ? 'Provider Settings (Configured)' : 'Provider Settings (API Key Required)'}
            type="button"
          >
            <Settings size={13} />
          </button>

          {/* New Chat Button */}
          <button
            className="btn-icon"
            onClick={handleNewChat}
            title="Start New Conversation"
            type="button"
          >
            <PlusCircle size={13} />
          </button>

          {/* Close Panel Button */}
          {onClose && (
            <button
              className="btn-icon"
              onClick={onClose}
              title="Close AI Assistant"
              type="button"
            >
              <X size={13} />
            </button>
          )}
        </div>
      </div>

      {/* Model Info Header Badge */}
      <div className="ai-model-badge-bar">
        <div className="model-badge-left">
          <Cpu size={11} className="model-icon" />
          <span className="model-label">Model:</span>
          <span className="model-name">{activeModelName}</span>
        </div>
        <div className="model-badge-right">
          <span
            className={`key-dot ${activeApiKey || providerType === 'opencode' ? 'active' : 'inactive'}`}
            title={activeApiKey ? 'API Key Configured' : providerType === 'opencode' ? 'Free Tier Ready' : 'API Key Missing'}
          />
          <span className="key-status-text">
            {activeApiKey ? 'Ready' : providerType === 'opencode' ? 'Free Tier' : 'No Key'}
          </span>
        </div>
      </div>

      {/* Settings Modal Dialog */}
      {showSettings && (
        <div className="ai-settings-modal-backdrop" onClick={() => setShowSettings(false)}>
          <div className="ai-settings-modal" onClick={(e) => e.stopPropagation()}>
            <div className="settings-modal-header">
              <div className="settings-header-left">
                <Key size={14} className="settings-key-icon" />
                <span>AI Provider Configuration</span>
              </div>
              <button
                className="btn-icon-close"
                onClick={() => setShowSettings(false)}
                type="button"
                title="Close settings"
              >
                <X size={14} />
              </button>
            </div>

            <div className="settings-modal-body">
              <div className="settings-provider-tabs">
                <button
                  type="button"
                  className={`tab-btn ${settingsProviderTab === 'gemini' ? 'active' : ''}`}
                  onClick={() => setSettingsProviderTab('gemini')}
                >
                  Google Gemini
                </button>
                <button
                  type="button"
                  className={`tab-btn ${settingsProviderTab === 'openrouter' ? 'active' : ''}`}
                  onClick={() => setSettingsProviderTab('openrouter')}
                >
                  OpenRouter (Free)
                </button>
                <button
                  type="button"
                  className={`tab-btn ${settingsProviderTab === 'nvidia' ? 'active' : ''}`}
                  onClick={() => setSettingsProviderTab('nvidia')}
                >
                  NVIDIA NIM
                </button>
                <button
                  type="button"
                  className={`tab-btn ${settingsProviderTab === 'opencode' ? 'active' : ''}`}
                  onClick={() => setSettingsProviderTab('opencode')}
                >
                  OpenCode (Free)
                </button>
              </div>

              <div className="settings-field-group">
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '4px' }}>
                  <label className="settings-label" style={{ marginBottom: 0 }}>
                    {settingsProviderTab === 'gemini'
                      ? 'Gemini API Key'
                      : settingsProviderTab === 'openrouter'
                      ? 'OpenRouter API Key'
                      : settingsProviderTab === 'nvidia'
                      ? 'NVIDIA NIM API Key'
                      : 'OpenCode Console API Key (Optional)'}
                  </label>
                  {(settingsProviderTab === 'gemini'
                    ? geminiKeyInput || (geminiApiKey && !geminiKeyCleared)
                    : settingsProviderTab === 'openrouter'
                    ? openRouterKeyInput || (openRouterApiKey && !openRouterKeyCleared)
                    : settingsProviderTab === 'nvidia'
                    ? nvidiaKeyInput || (nvidiaApiKey && !nvidiaKeyCleared)
                    : opencodeKeyInput || (opencodeApiKey && !opencodeKeyCleared)) && (
                    <button
                      type="button"
                      style={{
                        background: 'none',
                        border: 'none',
                        color: '#94a3b8',
                        fontSize: '11px',
                        cursor: 'pointer',
                        padding: '0 4px',
                        textDecoration: 'underline'
                      }}
                      onClick={() => {
                        if (settingsProviderTab === 'gemini') {
                          setGeminiKeyInput('')
                          setGeminiKeyCleared(true)
                        } else if (settingsProviderTab === 'openrouter') {
                          setOpenRouterKeyInput('')
                          setOpenRouterKeyCleared(true)
                        } else if (settingsProviderTab === 'nvidia') {
                          setNvidiaKeyInput('')
                          setNvidiaKeyCleared(true)
                        } else {
                          setOpencodeKeyInput('')
                          setOpencodeKeyCleared(true)
                        }
                      }}
                      title="Clear saved key"
                    >
                      Clear Key
                    </button>
                  )}
                </div>
                <div className="settings-input-wrapper">
                  <input
                    type={showKeyText ? 'text' : 'password'}
                    className="settings-input"
                    autoComplete="off"
                    autoCorrect="off"
                    autoCapitalize="off"
                    spellCheck={false}
                    placeholder={
                      (settingsProviderTab === 'gemini'
                        ? geminiApiKey && !geminiKeyCleared
                        : settingsProviderTab === 'openrouter'
                        ? openRouterApiKey && !openRouterKeyCleared
                        : settingsProviderTab === 'nvidia'
                        ? nvidiaApiKey && !nvidiaKeyCleared
                        : opencodeApiKey && !opencodeKeyCleared)
                        ? 'API key configured (enter new key to replace)'
                        : settingsProviderTab === 'gemini'
                        ? 'AIzaSy...'
                        : settingsProviderTab === 'openrouter'
                        ? 'sk-or-v1-...'
                        : settingsProviderTab === 'nvidia'
                        ? 'nvapi-...'
                        : 'Optional (Free models work without an API key)'
                    }
                    value={
                      settingsProviderTab === 'gemini'
                        ? geminiKeyInput
                        : settingsProviderTab === 'openrouter'
                        ? openRouterKeyInput
                        : settingsProviderTab === 'nvidia'
                        ? nvidiaKeyInput
                        : opencodeKeyInput
                    }
                    onChange={(e) => {
                      const val = e.target.value
                      if (settingsProviderTab === 'gemini') {
                        setGeminiKeyInput(val)
                        setGeminiKeyCleared(false)
                      } else if (settingsProviderTab === 'openrouter') {
                        setOpenRouterKeyInput(val)
                        setOpenRouterKeyCleared(false)
                      } else if (settingsProviderTab === 'nvidia') {
                        setNvidiaKeyInput(val)
                        setNvidiaKeyCleared(false)
                      } else {
                        setOpencodeKeyInput(val)
                        setOpencodeKeyCleared(false)
                      }
                    }}
                    autoFocus
                  />
                  <button
                    type="button"
                    className="settings-show-key-btn"
                    onClick={() => setShowKeyText(!showKeyText)}
                    title={showKeyText ? 'Hide key' : 'Show key'}
                  >
                    {showKeyText ? <EyeOff size={13} /> : <Eye size={13} />}
                  </button>
                </div>
                <span className="settings-hint">
                  {settingsProviderTab === 'opencode' ? (
                    <>
                      Free models work without an API key. For higher rate limits or Console access, enter your key or set{' '}
                      <code>OPENCODE_API_KEY</code>.
                    </>
                  ) : (
                    <>
                      Stored securely in local settings, or set{' '}
                      <code>
                        {settingsProviderTab === 'gemini'
                          ? 'GEMINI_API_KEY'
                          : settingsProviderTab === 'openrouter'
                          ? 'OPENROUTER_API_KEY'
                          : 'NVIDIA_API_KEY'}
                      </code>{' '}
                      in your local environment.
                    </>
                  )}
                </span>
              </div>

              {settingsProviderTab === 'nvidia' && (
                <div className="settings-field-group">
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '4px' }}>
                    <label className="settings-label" style={{ marginBottom: 0 }}>NVIDIA NIM Model ID</label>
                    <button
                      type="button"
                      className="btn btn-secondary btn-sm"
                      style={{ fontSize: '11px', padding: '2px 8px', display: 'flex', alignItems: 'center', gap: '4px' }}
                      disabled={isFetchingModels || !(nvidiaKeyInput || (nvidiaApiKey && !nvidiaKeyCleared))}
                      onClick={handleFetchNvidiaModels}
                      title="Query live models from NVIDIA NIM catalog"
                    >
                      {isFetchingModels && <Loader2 size={11} className="spin-icon" />}
                      <span>{isFetchingModels ? 'Fetching...' : 'Fetch Available Models'}</span>
                    </button>
                  </div>

                  {fetchModelsError && (
                    <div style={{ color: '#ef4444', fontSize: '11px', marginBottom: '6px', lineHeight: '1.4' }}>
                      {fetchModelsError}
                    </div>
                  )}

                  <div className="settings-input-wrapper">
                    {availableNvidiaModels.length > 0 ? (
                      <select
                        className="settings-input"
                        value={nvidiaModelInput}
                        onChange={(e) => setNvidiaModelInput(e.target.value)}
                      >
                        <option value="" disabled>-- Select a model from catalog --</option>
                        {!availableNvidiaModels.some((m) => m.id === nvidiaModelInput) && nvidiaModelInput && (
                          <option value={nvidiaModelInput}>{nvidiaModelInput} (Custom)</option>
                        )}
                        {availableNvidiaModels.map((m) => (
                          <option key={m.id} value={m.id}>{m.id}</option>
                        ))}
                      </select>
                    ) : (
                      <input
                        type="text"
                        className="settings-input"
                        placeholder="Click 'Fetch Available Models' to choose from active catalog"
                        value={nvidiaModelInput}
                        onChange={(e) => setNvidiaModelInput(e.target.value)}
                      />
                    )}
                  </div>
                  <span className="settings-hint">
                    {availableNvidiaModels.length > 0
                      ? `Fetched ${availableNvidiaModels.length} active models from NVIDIA NIM. Select your preferred model.`
                      : 'Fetch available models from the NVIDIA catalog or enter an active model ID.'}
                  </span>

                  {/* Connection Test Action */}
                  <div style={{ marginTop: '10px', display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                    <button
                      type="button"
                      className="btn btn-secondary btn-sm"
                      style={{ fontSize: '11px', padding: '3px 10px', display: 'flex', alignItems: 'center', gap: '4px' }}
                      disabled={isTestingConnection || !(nvidiaKeyInput || (nvidiaApiKey && !nvidiaKeyCleared)) || !(nvidiaModelInput || nvidiaModelId)}
                      onClick={handleTestNvidiaConnection}
                      title="Send ping request to verify API key and model availability"
                    >
                      {isTestingConnection && <Loader2 size={11} className="spin-icon" />}
                      <span>{isTestingConnection ? 'Testing Connection...' : 'Test Connection'}</span>
                    </button>
                    {connectionTestResult && (
                      <span
                        style={{
                          fontSize: '11px',
                          color: connectionTestResult.success ? '#10b981' : '#ef4444',
                          display: 'flex',
                          alignItems: 'center',
                          gap: '4px'
                        }}
                      >
                        {connectionTestResult.success ? (
                          <CheckCircle2 size={12} color="#10b981" />
                        ) : (
                          <AlertCircle size={12} color="#ef4444" />
                        )}
                        <span>{connectionTestResult.message}</span>
                      </span>
                    )}
                  </div>
                </div>
              )}

              {settingsProviderTab === 'opencode' && (
                <div className="settings-field-group">
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '4px' }}>
                    <label className="settings-label" style={{ marginBottom: 0 }}>OpenCode Model ID (Free)</label>
                    <button
                      type="button"
                      className="btn btn-secondary btn-sm"
                      style={{ fontSize: '11px', padding: '2px 8px', display: 'flex', alignItems: 'center', gap: '4px' }}
                      disabled={isFetchingOpencodeModels}
                      onClick={handleFetchOpencodeModels}
                      title="Query live free models from OpenCode catalog"
                    >
                      {isFetchingOpencodeModels && <Loader2 size={11} className="spin-icon" />}
                      <span>{isFetchingOpencodeModels ? 'Fetching...' : 'Fetch Available Models'}</span>
                    </button>
                  </div>

                  {fetchOpencodeModelsError && (
                    <div style={{ color: '#ef4444', fontSize: '11px', marginBottom: '6px', lineHeight: '1.4' }}>
                      {fetchOpencodeModelsError}
                    </div>
                  )}

                  <div className="settings-input-wrapper">
                    {availableOpencodeModels.length > 0 ? (
                      <select
                        className="settings-input"
                        value={opencodeModelInput}
                        onChange={(e) => setOpencodeModelInput(e.target.value)}
                      >
                        <option value="" disabled>-- Select a free model from catalog --</option>
                        {!availableOpencodeModels.some((m) => m.id === opencodeModelInput) && opencodeModelInput && (
                          <option value={opencodeModelInput}>{opencodeModelInput} (Custom)</option>
                        )}
                        {availableOpencodeModels.map((m) => (
                          <option key={m.id} value={m.id}>{m.id}</option>
                        ))}
                      </select>
                    ) : (
                      <input
                        type="text"
                        className="settings-input"
                        placeholder="e.g. space-bunny-free (Click 'Fetch Available Models' to list)"
                        value={opencodeModelInput}
                        onChange={(e) => setOpencodeModelInput(e.target.value)}
                      />
                    )}
                  </div>
                  <span className="settings-hint">
                    {availableOpencodeModels.length > 0
                      ? `Fetched ${availableOpencodeModels.length} free models from OpenCode. Default verified free model is space-bunny-free.`
                      : 'Fetch free models from the OpenCode catalog or use space-bunny-free (recommended default).'}
                  </span>

                  {/* Connection Test Action */}
                  <div style={{ marginTop: '10px', display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                    <button
                      type="button"
                      className="btn btn-secondary btn-sm"
                      style={{ fontSize: '11px', padding: '3px 10px', display: 'flex', alignItems: 'center', gap: '4px' }}
                      disabled={isTestingOpencodeConnection || !opencodeModelInput}
                      onClick={handleTestOpencodeConnection}
                      title="Send test request to verify OpenCode model availability"
                    >
                      {isTestingOpencodeConnection && <Loader2 size={11} className="spin-icon" />}
                      <span>{isTestingOpencodeConnection ? 'Testing Connection...' : 'Test Connection'}</span>
                    </button>
                    {opencodeConnectionTestResult && (
                      <span
                        style={{
                          fontSize: '11px',
                          color: opencodeConnectionTestResult.success ? '#10b981' : '#ef4444',
                          display: 'flex',
                          alignItems: 'center',
                          gap: '4px'
                        }}
                      >
                        {opencodeConnectionTestResult.success ? (
                          <CheckCircle2 size={12} color="#10b981" />
                        ) : (
                          <AlertCircle size={12} color="#ef4444" />
                        )}
                        <span>{opencodeConnectionTestResult.message}</span>
                      </span>
                    )}
                  </div>
                </div>
              )}

              <div className="settings-status-row">
                <span className="status-indicator">
                  {(settingsProviderTab === 'gemini'
                    ? geminiKeyInput.trim().length > 0
                    : settingsProviderTab === 'openrouter'
                    ? openRouterKeyInput.trim().length > 0
                    : settingsProviderTab === 'nvidia'
                    ? nvidiaKeyInput.trim().length > 0
                    : opencodeKeyInput.trim().length > 0) ? (
                    <>
                      <CheckCircle2 size={13} color="#10b981" /> New key entered (Click &apos;Save Settings&apos; to apply)
                    </>
                  ) : (settingsProviderTab === 'gemini'
                    ? geminiApiKey && !geminiKeyCleared
                    : settingsProviderTab === 'openrouter'
                    ? openRouterApiKey && !openRouterKeyCleared
                    : settingsProviderTab === 'nvidia'
                    ? nvidiaApiKey && !nvidiaKeyCleared
                    : opencodeApiKey && !opencodeKeyCleared) ? (
                    <>
                      <CheckCircle2 size={13} color="#10b981" /> API key configured (Saved in local settings)
                    </>
                  ) : settingsProviderTab === 'opencode' ? (
                    <>
                      <CheckCircle2 size={13} color="#10b981" /> Free tier ready (No API key required)
                    </>
                  ) : (
                    <>
                      <AlertCircle size={13} color="#f59e0b" /> No API key set
                    </>
                  )}
                </span>
              </div>
            </div>

            <div className="settings-modal-footer">
              <button type="button" className="btn btn-secondary btn-sm" onClick={() => setShowSettings(false)}>
                Cancel
              </button>
              <button type="button" className="btn btn-primary btn-sm" onClick={handleSaveSettingsKey}>
                Save Settings
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Messages Conversation List */}
      <div className="ai-messages-container">
        {messages.length === 0 && !isRunning && (
          <div className="ai-empty-state">
            <div className="ai-empty-icon-wrap">
              <Sparkles size={26} className="ai-empty-sparkle" />
            </div>
            <h4>AI Code Assistant</h4>
            <p>Ask coding questions, inspect project architecture, and manipulate workspace files.</p>
            <div className="ai-suggestion-list">
              <button
                type="button"
                className="suggestion-chip"
                onClick={() =>
                  handleSend('List the files in my current project and explain the project structure.')
                }
              >
                "List the files in my project and explain structure."
              </button>
              <button
                type="button"
                className="suggestion-chip"
                onClick={() =>
                  handleSend('Explain how the application state is managed.')
                }
              >
                "Explain how application state is managed."
              </button>
            </div>
          </div>
        )}

        {messages.map((msg) => (
          <div
            key={msg.id}
            className={`ai-message-row ${msg.role === 'user' ? 'user' : 'assistant'} ${
              msg.isError ? 'error' : ''
            }`}
          >
            <div className="ai-message-bubble">
              {/* Collapsible Tool Call summaries if any */}
              {msg.steps && msg.steps.length > 0 && (
                <div className="ai-tool-summary-list">
                  {msg.steps.map((step, idx) => {
                    const stepId = `${msg.id}-step-${idx}`
                    const isExpanded = !!expandedToolResults[stepId]
                    const isFileRead = step.toolName === 'read_file'
                    const isFileCreate = step.toolName === 'create_file'
                    const isFileEdit = step.toolName === 'edit_file'
                    const isRunCommand = step.toolName === 'run_command'
                    const isGitStatus = step.toolName === 'git_status'
                    const isGitDiff = step.toolName === 'git_diff'
                    const isGitLog = step.toolName === 'git_log'
                    const isSuccess = step.toolSuccess !== false
                    const pathArg =
                      step.toolArgs && typeof step.toolArgs === 'object' && 'path' in step.toolArgs
                        ? String(step.toolArgs.path)
                        : null
                    const commandArg =
                      step.toolArgs && typeof step.toolArgs === 'object' && 'command' in step.toolArgs
                        ? String(step.toolArgs.command)
                        : null

                    return (
                      <div key={stepId} className="ai-tool-accordion">
                        <div
                          className="ai-tool-accordion-header"
                          onClick={() => toggleToolResult(stepId)}
                        >
                          <span className="accordion-chevron">
                            {isExpanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                          </span>
                          {isFileEdit ? (
                            <FileEdit size={13} className="tool-icon-edit" />
                          ) : isFileCreate ? (
                            <FilePlus size={13} className="tool-icon-create" />
                          ) : isFileRead ? (
                            <FileCode size={13} className="tool-icon-read" />
                          ) : isRunCommand ? (
                            <TerminalIcon size={13} className="tool-icon-terminal" />
                          ) : isGitStatus ? (
                            <GitBranch size={13} className="tool-icon-git" />
                          ) : isGitDiff ? (
                            <FileDiff size={13} className="tool-icon-git" />
                          ) : isGitLog ? (
                            <History size={13} className="tool-icon-git" />
                          ) : (
                            <FolderTree size={13} className="tool-icon-list" />
                          )}
                          <span className="tool-name">
                            {step.toolName || 'tool'}
                            {pathArg && <span className="tool-path-arg"> ({pathArg})</span>}
                            {commandArg && <span className="tool-path-arg"> ({commandArg})</span>}
                          </span>
                          <span className={`tool-badge ${isSuccess ? 'success' : 'error'}`}>
                            {isSuccess ? '✓ Completed' : '✗ Failed'}
                          </span>
                        </div>

                        {isExpanded && step.toolOutput && (
                          <div className="ai-tool-accordion-body">
                            <pre>{step.toolOutput}</pre>
                          </div>
                        )}
                      </div>
                    )
                  })}
                </div>
              )}

              {/* Message text content */}
              {msg.role === 'assistant' && !msg.isError ? (
                <>
                  <MarkdownMessage content={msg.content} />
                  <div className="ai-message-actions">
                    <button
                      className="btn-copy-response"
                      onClick={() => handleCopyMessage(msg.id, msg.content)}
                      title="Copy complete response"
                      type="button"
                    >
                      {copiedMessageId === msg.id ? (
                        <>
                          <Check size={11} color="#10b981" />
                          <span>Copied</span>
                        </>
                      ) : (
                        <>
                          <Copy size={11} />
                          <span>Copy</span>
                        </>
                      )}
                    </button>
                  </div>
                </>
              ) : msg.isError ? (
                <div className="ai-error-bubble">
                  <div className="ai-error-header">
                    <AlertCircle size={14} className="ai-error-icon" />
                    <span>Request Error</span>
                  </div>
                  <div className="ai-error-message">{msg.content}</div>
                  {!activeApiKey && (
                    <button
                      type="button"
                      className="btn btn-secondary btn-sm ai-error-action-btn"
                      onClick={() => handleOpenSettings()}
                    >
                      <Settings size={12} />
                      <span>Configure API Key</span>
                    </button>
                  )}
                </div>
              ) : (
                <div className="ai-message-text">{msg.content}</div>
              )}
            </div>
          </div>
        ))}

        {/* User Approval Card for Sensitive Tool Execution (create_file, edit_file, run_command) */}
        {pendingApproval && (
          <div className="ai-message-row assistant">
            <div className="ai-approval-card">
              <div className="ai-approval-header">
                {pendingApproval.toolName === 'edit_file' ? (
                  <>
                    <FileEdit size={14} className="ai-approval-icon" />
                    <span className="ai-approval-title">Permission Request: Edit File</span>
                  </>
                ) : pendingApproval.toolName === 'run_command' ? (
                  <>
                    <TerminalIcon size={14} className="ai-approval-icon" />
                    <span className="ai-approval-title">Permission Request: Run Command</span>
                  </>
                ) : (
                  <>
                    <FilePlus size={14} className="ai-approval-icon" />
                    <span className="ai-approval-title">Permission Request: Create File</span>
                  </>
                )}
              </div>
              <div className="ai-approval-details">
                {pendingApproval.toolName === 'run_command' ? (
                  <>
                    {pendingApproval.isDangerous && (
                      <div className="danger-warning-badge">
                        <AlertTriangle size={13} className="danger-icon" />
                        <span>Warning: This command contains potentially destructive operations. Proceed with caution.</span>
                      </div>
                    )}
                    <div className="ai-approval-command-box">
                      <span className="prompt-sym">$</span>
                      <code className="command-text">{pendingApproval.command}</code>
                    </div>
                    <div className="ai-approval-path">
                      <span className="path-label">Working Directory:</span>
                      <code className="path-code">{pendingApproval.path}</code>
                    </div>
                  </>
                ) : (
                  <>
                    <div className="ai-approval-path">
                      <span className="path-label">File:</span>
                      <code className="path-code">{pendingApproval.path}</code>
                    </div>

                    {pendingApproval.toolName === 'edit_file' ? (
                      <>
                        <button
                          type="button"
                          className="ai-approval-preview-toggle"
                          onClick={() => setShowApprovalPreview((prev) => !prev)}
                        >
                          {showApprovalPreview ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                          <span>{showApprovalPreview ? 'Hide Diff Preview' : 'View Diff Preview'}</span>
                        </button>
                        {showApprovalPreview && (
                          <div className="ai-approval-diff-box">
                            <DiffPreview
                              oldContent={pendingApproval.oldContent || ''}
                              newContent={pendingApproval.newContent || ''}
                            />
                          </div>
                        )}
                      </>
                    ) : (
                      <>
                        <button
                          type="button"
                          className="ai-approval-preview-toggle"
                          onClick={() => setShowApprovalPreview((prev) => !prev)}
                        >
                          {showApprovalPreview ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                          <span>{showApprovalPreview ? 'Hide file preview' : 'View file preview'}</span>
                        </button>
                        {showApprovalPreview && (
                          <div className="ai-approval-code-preview">
                            <pre>{pendingApproval.content || '(empty file)'}</pre>
                          </div>
                        )}
                      </>
                    )}
                  </>
                )}
              </div>

              <div className="ai-approval-actions">
                <button
                  type="button"
                  className="btn-reject"
                  disabled={isApproving}
                  onClick={() => {
                    if (isApproving) return
                    setIsApproving(true)
                    const resolve = pendingApproval.resolve
                    setPendingApproval(null)
                    setShowApprovalPreview(true)
                    setIsApproving(false)
                    resolve(false)
                  }}
                >
                  <X size={12} />
                  <span>Reject</span>
                </button>
                <button
                  type="button"
                  className="btn-approve"
                  disabled={isApproving}
                  onClick={() => {
                    if (isApproving) return
                    setIsApproving(true)
                    const resolve = pendingApproval.resolve
                    setPendingApproval(null)
                    setShowApprovalPreview(true)
                    setIsApproving(false)
                    resolve(true)
                  }}
                >
                  <Check size={12} />
                  <span>
                    {pendingApproval.toolName === 'edit_file'
                      ? 'Apply Changes'
                      : pendingApproval.toolName === 'run_command'
                      ? 'Run Command'
                      : 'Create File'}
                  </span>
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Live Running Indicator (Only one active status card at a time, hidden when pending approval) */}
        {isRunning &&
          !pendingApproval &&
          (currentStep?.type === 'tool_call' ||
            currentStep?.type === 'retrying' ||
            !messages.some((m) => m.id === `${currentRequestIdRef.current}-res` && m.content)) && (
            <div className="ai-message-row assistant">
              <div className="ai-message-bubble running-status">
                <div className="single-status-indicator">
                  {currentStep?.type === 'tool_call' ? (
                    <>
                      <Loader2 size={13} className="spin-icon" color="#38bdf8" />
                      <span>⚙ Running tool: <strong>{currentStep.toolName}</strong>...</span>
                    </>
                  ) : currentStep?.type === 'retrying' ? (
                    <>
                      <Loader2 size={13} className="spin-icon" color="#f59e0b" />
                      <span style={{ color: '#f59e0b' }}>↻ {currentStep.text || 'Temporary provider issue. Retrying...'}</span>
                    </>
                  ) : (
                    <>
                      <Loader2 size={13} className="spin-icon" color="#38bdf8" />
                      <span>● Thinking...</span>
                    </>
                  )}
                </div>
              </div>
            </div>
          )}

        <div ref={messagesEndRef} />
      </div>

      {/* Fixed Bottom Input Bar */}
      <div className="ai-input-wrapper">
        <form
          className="ai-input-form"
          onSubmit={(e) => {
            e.preventDefault()
            handleSend()
          }}
        >
          <div className="ai-prompt-input-container">
            <textarea
              className="ai-prompt-input"
              rows={2}
              placeholder={`Ask AI about your code... (Enter to send, Shift+Enter for newline)`}
              value={inputPrompt}
              onChange={(e) => setInputPrompt(e.target.value)}
              disabled={isRunning}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault()
                  handleSend()
                }
              }}
            />
            <div className="ai-input-bottom-actions">
              <div className="ai-input-hint">
                <span>{isRunning ? 'Generation in progress' : 'Press Enter to submit'}</span>
              </div>
              {isRunning ? (
                <button
                  type="button"
                  className="ai-stop-btn"
                  onClick={handleStop}
                  title="Stop generation"
                >
                  <Square size={12} fill="#fff" />
                  <span>Stop</span>
                </button>
              ) : (
                <button
                  type="submit"
                  className="ai-send-btn"
                  disabled={!inputPrompt.trim() || isRunning}
                  title="Send message (Enter)"
                >
                  <Send size={13} />
                  <span>Send</span>
                </button>
              )}
            </div>
          </div>
        </form>
      </div>
    </div>
  )
}
