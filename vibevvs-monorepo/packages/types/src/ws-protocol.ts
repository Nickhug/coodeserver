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
  
  // User data messages
  USER_DATA_REQUEST = 'user_data_request',
  USER_DATA_RESPONSE = 'user_data_response',
  
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