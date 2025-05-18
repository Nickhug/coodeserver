/**
 * Configuration for the WebSocket server
 */

// Default configuration values
const DEFAULT_PORT = 3001;
const DEFAULT_HOST = '0.0.0.0'; // Changed to IPv4 only for TCP proxy usage
const DEFAULT_WS_PATH = '/ws';
const DEFAULT_PING_INTERVAL = 30000; // 30 seconds

// Environment variables
export const config = {
  // Server settings
  port: process.env.WS_PORT ? parseInt(process.env.WS_PORT, 10) : DEFAULT_PORT,
  host: process.env.WS_HOST || DEFAULT_HOST,
  wsPath: process.env.WS_PATH || DEFAULT_WS_PATH,
  environment: process.env.NODE_ENV || 'development',
  pingInterval: process.env.PING_INTERVAL ? parseInt(process.env.PING_INTERVAL, 10) : DEFAULT_PING_INTERVAL,
  
  // Authentication
  authEnabled: process.env.AUTH_ENABLED !== 'false',
  clerkSecretKey: process.env.CLERK_SECRET_KEY || '',
  clerkJwtKey: process.env.CLERK_JWT_KEY || '',
  
  // CORS
  corsOrigins: process.env.CORS_ORIGINS ? process.env.CORS_ORIGINS.split(',') : ['http://localhost:3000'],
  
  // Default Provider
  defaultProvider: process.env.DEFAULT_PROVIDER || 'gemini',
  
  // AI Provider API Keys
  openaiApiKey: process.env.OPENAI_API_KEY || '',
  geminiApiKey: process.env.GEMINI_API_KEY || '',
  groqApiKey: process.env.GROQ_API_KEY || '',
  mistralApiKey: process.env.MISTRAL_API_KEY || '',
};

/**
 * Validate the configuration and return any errors
 */
export function validateConfig(): { isValid: boolean; errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];

  // Server configuration validation
  if (isNaN(config.port) || config.port <= 0) {
    errors.push(`Invalid port number: ${config.port}`);
  }

  if (!config.host) {
    errors.push('Host cannot be empty');
  }
  
  // Downgrade this from an error to a warning since we're using TCP proxy, not private networking
  if (config.host === '0.0.0.0') {
    warnings.push('Host set to 0.0.0.0 (IPv4 only). For Railway private networking to work, host should be "::" (dual stack IPv4/IPv6)');
  }

  if (!config.wsPath) {
    errors.push('WebSocket path cannot be empty');
  }

  // Authentication validation
  if (config.authEnabled && !config.clerkSecretKey && !config.clerkJwtKey) {
    errors.push('Authentication is enabled but neither CLERK_SECRET_KEY nor CLERK_JWT_KEY is provided');
  }

  // Provider validation
  if (config.defaultProvider === 'gemini' && !config.geminiApiKey) {
    errors.push('Gemini is set as the default provider but GEMINI_API_KEY is not provided');
  }

  if (config.defaultProvider === 'openai' && !config.openaiApiKey) {
    errors.push('OpenAI is set as the default provider but OPENAI_API_KEY is not provided');
  }

  if (config.defaultProvider === 'groq' && !config.groqApiKey) {
    errors.push('Groq is set as the default provider but GROQ_API_KEY is not provided');
  }

  if (config.defaultProvider === 'mistral' && !config.mistralApiKey) {
    errors.push('Mistral is set as the default provider but MISTRAL_API_KEY is not provided');
  }

  return {
    isValid: errors.length === 0,
    errors,
    warnings,
  };
}

export default config;
