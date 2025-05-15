/**
 * Export all types from the package
 */
 
export * from './ws-protocol'; 

// Message types for WebSocket communication
export enum MessageType {
  // Connection messages
  CONNECT_SUCCESS = 'connect_success',
  PING = 'ping',
  PONG = 'pong',
  
  // Authentication messages
  AUTHENTICATE = 'authenticate',
  AUTH_SUCCESS = 'auth_success',
  AUTH_FAILURE = 'auth_failure',
  
  // Provider messages
  PROVIDER_LIST = 'provider_list',
  PROVIDER_MODELS = 'provider_models',
  PROVIDER_REQUEST = 'provider_request',
  PROVIDER_RESPONSE = 'provider_response',
  PROVIDER_ERROR = 'provider_error',
  PROVIDER_STREAM_START = 'provider_stream_start',
  PROVIDER_STREAM_CHUNK = 'provider_stream_chunk',
  PROVIDER_STREAM_END = 'provider_stream_end',
  
  // Tool messages
  TOOL_EXECUTION_RESULT = 'tool_execution_result',
  
  // Generic messages
  ERROR = 'error'
}

// User interface
export interface User {
  id: string;
  email: string;
  clerk_id: string;
  credits_remaining: number;
  subscription_tier: string | null;
  created_at: string;
  updated_at: string;
}

// Auth token interface
export interface AuthToken {
  id: string;
  token: string;
  user_id: string;
  expires_at: string;
  created_at: string;
}

// Basic client message interface
export interface ClientMessage {
  type: MessageType;
  payload?: any;
}

// Basic server message interface
export interface ServerMessage {
  type: MessageType;
  payload?: any;
}

// Authentication message
export interface AuthenticateMessage extends ClientMessage {
  type: MessageType.AUTHENTICATE;
  payload: {
    token: string;
  };
}

// Authentication success message
export interface AuthSuccessMessage extends ServerMessage {
  type: MessageType.AUTH_SUCCESS;
  payload: {
    userId: string;
    connectionId: string;
    user?: UserData;
    serverTime: string;
  };
}

// Authentication failure message
export interface AuthFailureMessage extends ServerMessage {
  type: MessageType.AUTH_FAILURE;
  payload: {
    error: string;
    message?: string;
    code?: string;
  };
}

// Connection success message
export interface ConnectSuccessMessage extends ServerMessage {
  type: MessageType.CONNECT_SUCCESS;
  payload: {
    connectionId: string;
    userId: string | null;
    serverTime: string;
    serverInfo?: {
      environment: string;
      version?: string;
    };
  };
}

// Ping message
export interface ClientPingMessage extends ClientMessage {
  type: MessageType.PING;
  payload?: {
    clientTime?: number;
  };
}

// Pong message
export interface ServerPongMessage extends ServerMessage {
  type: MessageType.PONG;
  payload: {
    serverTime: number;
  };
}

// Error message
export interface ErrorMessage extends ServerMessage {
  type: MessageType.ERROR;
  payload: {
    error: string;
    code?: string;
  };
}

// Provider list message
export interface ProviderListMessage extends ServerMessage {
  type: MessageType.PROVIDER_LIST;
  payload: {
    providers: {
      id: string;
      name: string;
      description?: string;
      isAvailable: boolean;
    }[];
  };
}

// Provider models message
export interface ProviderModelsMessage extends ServerMessage {
  type: MessageType.PROVIDER_MODELS;
  payload: {
    provider: string;
    models: {
      id: string;
      name: string;
      description?: string;
      contextLength?: number;
      isAvailable: boolean;
    }[];
  };
}

// Provider request message
export interface ProviderRequestMessage extends ClientMessage {
  type: MessageType.PROVIDER_REQUEST;
  payload: {
    provider: string;
    model: string;
    messages: any[];
    options?: any;
    requestId?: string;
  };
}

// Provider stream start message
export interface ProviderStreamStartMessage extends ServerMessage {
  type: MessageType.PROVIDER_STREAM_START;
  payload: {
    requestId: string;
    provider: string;
    model: string;
  };
}

// Provider stream chunk message
export interface ProviderStreamChunkMessage extends ServerMessage {
  type: MessageType.PROVIDER_STREAM_CHUNK;
  payload: {
    requestId: string;
    chunk: any;
  };
}

// Provider stream end message
export interface ProviderStreamEndMessage extends ServerMessage {
  type: MessageType.PROVIDER_STREAM_END;
  payload: {
    requestId: string;
    usage?: {
      prompt_tokens: number;
      completion_tokens: number;
      total_tokens: number;
    };
  };
}

// Provider error message
export interface ProviderErrorMessage extends ServerMessage {
  type: MessageType.PROVIDER_ERROR;
  payload: {
    requestId?: string;
    error: string;
    code?: string;
  };
}

// Tool execution result message
export interface ToolExecutionResultMessage extends ClientMessage {
  type: MessageType.TOOL_EXECUTION_RESULT;
  payload: {
    requestId: string;
    toolCallId: string;
    toolName: string;
    result: any;
    isError: boolean;
    errorDetails?: string;
  };
}

// User data structure
export interface UserData {
  id: string;
  email?: string;
  firstName?: string;
  lastName?: string;
  displayName?: string;
  credits?: number;
  subscription?: string;
}

// Combine client message types
export type ClientToServerMessage =
  | AuthenticateMessage
  | ClientPingMessage
  | ProviderRequestMessage
  | ToolExecutionResultMessage;

// Combine server message types
export type ServerToClientMessage =
  | ConnectSuccessMessage
  | AuthSuccessMessage
  | AuthFailureMessage
  | ServerPongMessage
  | ErrorMessage
  | ProviderListMessage
  | ProviderModelsMessage
  | ProviderStreamStartMessage
  | ProviderStreamChunkMessage
  | ProviderStreamEndMessage
  | ProviderErrorMessage;

export default {
  MessageType
}; 