import dotenv from 'dotenv';
dotenv.config();

import logger from '@repo/logger';
import { startWebSocketServer } from './server';
import { config, validateConfig } from './config';
import { initClerk } from '@repo/auth';

// Print startup banner with configuration
logger.info('┋==================================┋');
logger.info('┋🚀 Coode WebSocket Server Starting┋');
logger.info('┋==================================┋');
logger.info(`Environment: ${config.environment}`);
logger.info(`WebSocket Path: ${config.wsPath}`);
logger.info(`Auth HTTP Path: /api/auth`);
logger.info(`Port: ${config.port}`);
logger.info(`Host: ${config.host}`);
logger.info(`Auth Enabled: ${config.authEnabled}`);

// Validate the configuration
const { isValid, errors } = validateConfig();
if (!isValid) {
  logger.error('Configuration issues detected:');
  errors.forEach(error => logger.error(`  - ${error}`));
  
  if (config.environment === 'production') {
    logger.error('Fatal configuration errors in production mode. Exiting...');
    process.exit(1);
  } else {
    logger.warn('Continuing with invalid configuration in development mode');
  }
}

// Initialize Clerk if authentication is enabled and key is provided
if (config.authEnabled && config.clerkSecretKey) {
  initClerk(config.clerkSecretKey);
} else if (config.authEnabled) {
  logger.warn('⚠️ Authentication is enabled but CLERK_SECRET_KEY is not set');
}

// Log additional warnings about missing keys
if (!config.geminiApiKey && config.defaultProvider === 'gemini') {
  logger.warn('⚠️ GEMINI_API_KEY is not set but it is the default provider');
}

logger.info('=================================');

// Start the WebSocket server
const server = startWebSocketServer();

// Handle graceful shutdown
process.on('SIGINT', () => {
  logger.info('Received SIGINT, shutting down gracefully...');
  server.close(() => {
    logger.info('Server closed');
    process.exit(0);
  });
});

process.on('SIGTERM', () => {
  logger.info('Received SIGTERM, shutting down gracefully...');
  server.close(() => {
    logger.info('Server closed');
  process.exit(0);
  });
});

// Handle uncaught exceptions
process.on('uncaughtException', (error) => {
  logger.error('Uncaught exception:', error);
  process.exit(1);
});

// Handle unhandled promise rejections
process.on('unhandledRejection', (reason, promise) => {
  logger.error('Unhandled promise rejection:', reason);
  process.exit(1);
}); 