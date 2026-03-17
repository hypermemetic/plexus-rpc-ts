// plexus-rpc protocol types — wire format
// snake_case fields match the Haskell/Rust serialization

// ── Stream items ──────────────────────────────────────────────────────────────

export interface StreamMetadata {
  provenance: string[]
  plexusHash: string
  timestamp: number
}

export interface PlexusStreamItemData {
  type: 'data'
  metadata: StreamMetadata
  contentType: string
  content: unknown
}

export interface PlexusStreamItemProgress {
  type: 'progress'
  metadata: StreamMetadata
  message: string
  percentage?: number
}

export interface PlexusStreamItemError {
  type: 'error'
  metadata: StreamMetadata
  message: string
  code?: string
  recoverable: boolean
}

export interface PlexusStreamItemDone {
  type: 'done'
  metadata: StreamMetadata
}

export interface PlexusStreamItemRequest {
  type: 'request'
  requestId: string
  requestData: StandardRequest
  timeoutMs: number
}

export type PlexusStreamItem =
  | PlexusStreamItemData
  | PlexusStreamItemProgress
  | PlexusStreamItemError
  | PlexusStreamItemDone
  | PlexusStreamItemRequest

// ── Schema wire types (snake_case — matches Haskell/Rust) ────────────────────

export interface ChildSummary {
  namespace: string    // single segment, e.g. 'earth'
  description: string
  hash: string
}

export interface MethodSchema {
  name: string
  description: string
  hash: string
  params?: unknown
  returns?: unknown
  streaming: boolean
  bidirectional: boolean
  request_type?: unknown
  response_type?: unknown
}

export interface PluginSchema {
  namespace: string       // full dot path, e.g. 'solar.earth'
  version: string
  description: string
  long_description?: string
  hash: string
  methods: MethodSchema[]
  children?: ChildSummary[]  // undefined = leaf, array (possibly empty) = hub
}

// ── Bidirectional request/response ───────────────────────────────────────────

export interface SelectOption {
  value: string
  label: string
  description?: string
}

export interface StandardRequestConfirm {
  type: 'confirm'
  message: string
  default?: boolean
}

export interface StandardRequestPrompt {
  type: 'prompt'
  message: string
  default?: string
  placeholder?: string
}

export interface StandardRequestSelect {
  type: 'select'
  message: string
  options: SelectOption[]
  multiSelect?: boolean
}

export type StandardRequest =
  | StandardRequestConfirm
  | StandardRequestPrompt
  | StandardRequestSelect

export interface PlexusResponse {
  requestId: string
  response: StandardResponse
}

export interface StandardResponseConfirmed { type: 'confirmed'; value: boolean }
export interface StandardResponseText      { type: 'text';      value: string  }
export interface StandardResponseSelected  { type: 'selected';  values: string[] }
export interface StandardResponseCancelled { type: 'cancelled' }

export type StandardResponse =
  | StandardResponseConfirmed
  | StandardResponseText
  | StandardResponseSelected
  | StandardResponseCancelled

// ── Error class ───────────────────────────────────────────────────────────────

export class PlexusError extends Error {
  readonly code: string | undefined
  readonly recoverable: boolean
  readonly metadata: StreamMetadata | undefined
  constructor(message: string, code?: string, recoverable = false, metadata?: StreamMetadata) {
    super(message)
    this.name = 'PlexusError'
    this.code = code
    this.recoverable = recoverable
    this.metadata = metadata
  }
}
