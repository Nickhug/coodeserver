/**
 * WebSocket Protocol Definition
 * This file defines the types and interfaces for the WebSocket communication protocol
 * between the Void client and the backend services.
 */

/**
 * Message types for WebSocket communication
 */
export enum MessageType {
  // Connection messages
  CONNECT_SUCCESS = 'connect_success',
  CONNECT_ERROR = 'connect_error',

  // Authentication messages
  AUTHENTICATE = 'authenticate',
  AUTH_SUCCESS = 'auth_success',
  AUTH_FAILURE = 'auth_failure',

  // Keep-alive messages
  PING = 'ping',
  PONG = 'pong',

  // Provider discovery messages
  PROVIDER_LIST = 'provider_list',
  PROVIDER_MODELS = 'provider_models',

  // Provider interaction messages
  PROVIDER_REQUEST = 'provider_request',
  PROVIDER_RESPONSE = 'provider_response',
  PROVIDER_ERROR = 'provider_error',

  // Streaming messages
  PROVIDER_STREAM_START = 'provider_stream_start',
  PROVIDER_STREAM_CHUNK = 'provider_stream_chunk',
  PROVIDER_STREAM_END = 'provider_stream_end',

  // Tool messages
  TOOL_EXECUTION_RESULT = 'tool_execution_result',

  // User data messages
  USER_DATA_REQUEST = 'user_data_request',
  USER_DATA_RESPONSE = 'user_data_response',

  // Codebase indexing messages
  CODEBASE_INDEX_REQUEST = 'codebase_index_request',
  CODEBASE_INDEX_RESPONSE = 'codebase_index_response',
  CODEBASE_EMBEDDING_REQUEST = 'codebase_embedding_request',
  CODEBASE_EMBEDDING_RESPONSE = 'codebase_embedding_response',
  CODEBASE_EMBEDDING_BATCH_REQUEST = 'codebase_embedding_batch_request',
  CODEBASE_EMBEDDING_BATCH_RESPONSE = 'codebase_embedding_batch_response',
  CODEBASE_EMBEDDING_PROGRESS = 'codebase_embedding_progress',
  CODEBASE_SEARCH_REQUEST = 'codebase_search_request',
  CODEBASE_SEARCH_RESPONSE = 'codebase_search_response',
  CODEBASE_CLEAR_INDEX_REQUEST = 'codebase_clear_index_request',
  CODEBASE_CLEAR_INDEX_RESPONSE = 'codebase_clear_index_response',
  
  // Document indexing messages
  INDEX_DOCUMENT = 'index-document',
  DOCUMENT_INDEXED = 'document-indexed',
  DOCUMENT_INDEXING_PROGRESS = 'document-indexing-progress',
  DOCUMENT_INDEX_ERROR = 'document-index-error',
  REMOVE_DOCUMENT = 'remove-document',
  DOCUMENT_REMOVED = 'document-removed',
  DOCUMENT_REMOVE_ERROR = 'document-remove-error',

  // General error
  ERROR = 'error'
}

/**
 * Base message interface
 */
interface BaseMessage {
  type: MessageType;
  timestamp?: number;
  payload: Record<string, any>;
}

/**
 * Client message interface - messages sent from client to server
 */
export interface ClientMessage extends BaseMessage {
  type: MessageType;
  payload: any;
}

/**
 * Server message interface - messages sent from server to client
 */
export interface ServerMessage extends BaseMessage {
  type: MessageType;
  payload: any;
}

/**
 * Authentication request payload
 */
export interface AuthenticatePayload {
  token: string;
}

/**
 * Provider request payload
 */
export interface ProviderRequestPayload {
  provider: string;
  model: string;
  prompt: string;
  temperature?: number;
  maxTokens?: number;
  stream?: boolean;
  systemMessage?: string;
  requestId?: string;
  tools?: Array<{
    name: string;
    description: string;
    parameters: Record<string, { description: string }>;
  }> | null;
}

/**
 * Provider models request payload
 */
export interface ProviderModelsPayload {
  provider: string;
}

/**
 * Provider response payload
 */
export interface ProviderResponsePayload {
  text: string;
  tokensUsed: number;
  success: boolean;
  error?: string;
  requestId?: string;
  toolCall?: {
    name: string;
    parameters: Record<string, unknown>;
    id: string;
  };
  waitingForToolCall?: boolean;
}

/**
 * Provider stream start payload
 */
export interface ProviderStreamStartPayload {
  provider: string;
  model: string;
  requestId?: string;
}

/**
 * Provider stream chunk payload
 */
export interface ProviderStreamChunkPayload {
  chunk: string;
  requestId?: string;
  toolCallUpdate?: {
    name: string;
    parameters: Record<string, unknown>;
    id?: string;
  };
}

/**
 * Provider stream end payload
 */
export interface ProviderStreamEndPayload {
  tokensUsed: number;
  success: boolean;
  error?: string;
  requestId?: string;
  toolCall?: {
    name: string;
    parameters: Record<string, unknown>;
    id: string;
  };
  waitingForToolCall?: boolean;
}

/**
 * Connection success payload
 */
export interface ConnectSuccessPayload {
  connectionId: string;
  userId: string | null;
  serverTime: string;
  serverInfo: {
    environment: string;
  };
}

/**
 * Authentication success payload
 */
export interface AuthSuccessPayload {
  userId: string;
  connectionId: string;
}

/**
 * Error payload
 */
export interface ErrorPayload {
  error: string;
  code: string;
}

/**
 * Provider list payload
 */
export interface ProviderListPayload {
  providers: Array<{
    id: string;
    name: string;
    available: boolean;
  }>;
  defaultProvider: string;
}

/**
 * Provider models payload
 */
export interface ProviderModelsPayload {
  provider: string;
  available: boolean;
  models: Array<{
    id: string;
    name: string;
    provider: string;
    available: boolean;
    contextWindow: number;
    maxOutputTokens: number;
    features: string[];
  }>;
}

/**
 * Type definitions for specific message types
 */
export type AuthenticateMessage = ClientMessage & { payload: AuthenticatePayload };
export type ProviderRequestMessage = ClientMessage & { payload: ProviderRequestPayload };
export type ProviderListMessage = ServerMessage & { payload: ProviderListPayload };
export type ProviderResponseMessage = ServerMessage & { payload: ProviderResponsePayload };
export type ConnectSuccessMessage = ServerMessage & { payload: ConnectSuccessPayload };
export type ErrorMessage = ServerMessage & { payload: ErrorPayload };

/**
 * User data request payload
 */
export interface UserDataRequestPayload {
  userId: string;
}

/**
 * User data response payload
 */
export interface UserDataResponsePayload {
  user?: {
    id: string;
    email: string;
    credits: number;
    subscription: string;
    name?: string;
    avatarUrl?: string;
    username?: string;
  };
  error?: string;
}

/**
 * User data request message
 */
export type UserDataRequestMessage = ClientMessage & { payload: UserDataRequestPayload };

/**
 * User data response message
 */
export type UserDataResponseMessage = ServerMessage & { payload: UserDataResponsePayload };

/**
 * Code chunk interface for codebase indexing
 */
export interface CodeChunk {
  id: string;
  filePath: string;
  startLine: number;
  endLine: number;
  content: string;
  type: 'function' | 'class' | 'method' | 'interface' | 'type' | 'variable' | 'import' | 'export';
  name?: string;
  language: string;
  metadata?: {
    signature?: string;
    docstring?: string;
    complexity?: number;
    dependencies?: string[];
    exports?: string[];
  };
}

/**
 * Codebase embedding request payload
 */
export interface CodebaseEmbeddingRequestPayload {
  requestId: string;
  chunk: CodeChunk;
  model?: string;
}

/**
 * Codebase embedding response payload
 */
export interface CodebaseEmbeddingResponsePayload {
  requestId: string;
  chunkId: string;
  embedding: number[];
  model: string;
  tokensUsed?: number;
  cached?: boolean;
  error?: string;
}

/**
 * Codebase embedding batch request payload
 */
export interface CodebaseEmbeddingBatchRequestPayload {
  requestId: string;
  chunks: CodeChunk[];
  model?: string;
}

/**
 * Codebase embedding batch response payload
 */
export interface CodebaseEmbeddingBatchResponsePayload {
  requestId: string;
  embeddings: Array<{
    chunkId: string;
    embedding: number[];
    cached?: boolean;
  }>;
  model: string;
  totalTokensUsed?: number;
  errors?: Array<{
    chunkId: string;
    error: string;
  }>;
}

/**
 * Codebase search request payload
 */
export interface CodebaseSearchRequestPayload {
  requestId: string;
  query: string;
  limit?: number;
  filters?: {
    fileTypes?: string[];
    paths?: string[];
    languages?: string[];
  };
}

/**
 * Codebase search response payload
 */
export interface CodebaseSearchResponsePayload {
  requestId: string;
  results: Array<{
    chunk: CodeChunk;
    score: number;
    highlights?: string[];
  }>;
  error?: string;
  stats?: {
    vectorCount: number;
    namespace: string;
  };
}

/**
 * Codebase clear index request payload
 */
export interface CodebaseClearIndexRequestPayload {
  requestId: string;
}

/**
 * Codebase clear index response payload
 */
export interface CodebaseClearIndexResponsePayload {
  requestId: string;
  success: boolean;
  error?: string;
  deletedVectorCount?: number;
}

/**
 * Type definitions for codebase indexing messages
 */
export type CodebaseEmbeddingRequestMessage = ClientMessage & { payload: CodebaseEmbeddingRequestPayload };
export type CodebaseEmbeddingResponseMessage = ServerMessage & { payload: CodebaseEmbeddingResponsePayload };
export type CodebaseEmbeddingBatchRequestMessage = ClientMessage & { payload: CodebaseEmbeddingBatchRequestPayload };
export type CodebaseEmbeddingBatchResponseMessage = ServerMessage & { payload: CodebaseEmbeddingBatchResponsePayload };
export type CodebaseSearchRequestMessage = ClientMessage & { payload: CodebaseSearchRequestPayload };
export type CodebaseSearchResponseMessage = ServerMessage & { payload: CodebaseSearchResponsePayload };
export type CodebaseClearIndexRequestMessage = ClientMessage & { payload: CodebaseClearIndexRequestPayload };
export type CodebaseClearIndexResponseMessage = ServerMessage & { payload: CodebaseClearIndexResponsePayload };