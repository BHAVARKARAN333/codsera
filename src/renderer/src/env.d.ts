/// <reference types="vite/client" />

import { IElectronAPI } from '../../shared/types'

declare global {
  interface Window {
    electronAPI: IElectronAPI
  }
}
