/// <reference types="vite/client" />

import { IElectronAPI } from '../../shared/types'
import type {
  SmartContextEngine
} from './services/agent/smartContextEngine'

declare global {
  interface Window {
    electronAPI: IElectronAPI
    __enableProfiling?: (enabled?: boolean) => SmartContextEngine | void
  }
}
