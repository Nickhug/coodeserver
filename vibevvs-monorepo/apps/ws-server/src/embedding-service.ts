import logger from '@repo/logger';
import { config } from './config';
import * as gemini from '@repo/ai-providers';
import { CodeChunk } from '@repo/types';
import crypto from 'crypto';
import * as pineconeService from './pinecone-service';

// Define EmbeddingResponse locally
interface EmbeddingResponse {
  chunkId: string;
  embedding: number[];
  model: string;
  tokensUsed?: number;
}

// Configuration
const EMBEDDING_MODEL = config.embeddingModel || 'text-embedding-004';
const EMBEDDING_API_VERSION = (config.embeddingApiVersion || 'v1alpha') as 'v1alpha' | 'v1beta'; // Use v1alpha for experimental models
const RATE_LIMIT = config.embeddingRateLimit || 10; // requests per minute
const BATCH_SIZE = 5; // embeddings per batch

// Rate limiting with more conservative approach
const rateLimiter = {
  requests: 0,
  resetTime: Date.now() + 60000, // 1 minute window
  lastRequestTime: 0,
  minDelayBetweenRequests: 6000, // 6 seconds between requests (10 per minute)
  
  async checkLimit(): Promise<boolean> {
    const now = Date.now();
    if (now > this.resetTime) {
      this.requests = 0;
      this.resetTime = now + 60000;
    }
    
    if (this.requests >= RATE_LIMIT) {
      return false;
    }
    
    // Check minimum delay between requests
    const timeSinceLastRequest = now - this.lastRequestTime;
    if (timeSinceLastRequest < this.minDelayBetweenRequests) {
      return false;
    }
    
    this.requests++;
    this.lastRequestTime = now;
    return true;
  },
  
  async waitForSlot(): Promise<void> {
    while (!(await this.checkLimit())) {
      const now = Date.now();
      const waitTime = Math.max(
        this.resetTime - now,
        this.minDelayBetweenRequests - (now - this.lastRequestTime)
      );
      logger.info(`Rate limit: waiting ${waitTime}ms before next request`);
      await new Promise(resolve => setTimeout(resolve, Math.min(waitTime + 100, 10000))); // Add 100ms buffer
    }
  }
};

/**
 * Generate a unique key for a code chunk
 */
function generateChunkKey(chunk: CodeChunk): string {
  const hash = crypto.createHash('sha256');
  hash.update(chunk.filePath);
  hash.update(chunk.content);
  hash.update(chunk.type);
  hash.update(String(chunk.startLine));
  hash.update(String(chunk.endLine));
  return hash.digest('hex');
}

/**
 * Generate embedding for a single code chunk
 */
export async function generateChunkEmbedding(
  chunk: CodeChunk,
  userId: string
): Promise<EmbeddingResponse> {
  const chunkKey = generateChunkKey(chunk);
  
  // Wait for rate limit
  await rateLimiter.waitForSlot();
  
  // Generate new embedding
  const result = await gemini.generateEmbedding({
    apiKey: config.geminiApiKey,
    content: formatChunkForEmbedding(chunk),
    model: EMBEDDING_MODEL,
    apiVersion: EMBEDDING_API_VERSION,
  });
  
  if (result.error) {
    throw new Error(result.error);
  }
  
  // Store in Pinecone
  await pineconeService.upsertVectors(userId, [{
    id: chunkKey,
    values: result.embedding,
    metadata: {
      chunkId: chunk.id,
      filePath: chunk.filePath,
      type: chunk.type,
      language: chunk.language,
      content: chunk.content,
      startLine: chunk.startLine,
      endLine: chunk.endLine,
      name: chunk.name,
      ...chunk.metadata,
      // Add file extension for filtering
      fileType: chunk.filePath.split('.').pop() || ''
    }
  }]);
  
  return {
    chunkId: chunk.id,
    embedding: result.embedding,
    model: result.model,
    tokensUsed: result.tokensUsed,
  };
}

/**
 * Generate embeddings for multiple chunks in batch
 */
export async function generateBatchEmbeddings(
  chunks: CodeChunk[],
  userId: string
): Promise<{
  embeddings: EmbeddingResponse[];
  errors: Array<{ chunkId: string; error: string }>;
  totalTokensUsed: number;
}> {
  const embeddings: EmbeddingResponse[] = [];
  const errors: Array<{ chunkId: string; error: string }> = [];
  let totalTokensUsed = 0;
  
  // Process chunks in batches
  for (let i = 0; i < chunks.length; i += BATCH_SIZE) {
    const batch = chunks.slice(i, i + BATCH_SIZE);
    
    // Prepare chunks for embedding
    const chunksToEmbed: Array<{ chunk: CodeChunk; key: string }> = [];
    
    for (const chunk of batch) {
      const chunkKey = generateChunkKey(chunk);
      chunksToEmbed.push({ chunk, key: chunkKey });
    }
    
    if (chunksToEmbed.length > 0) {
      // Wait for rate limit
      await rateLimiter.waitForSlot();
      
      // Generate embeddings for uncached chunks
      const contents = chunksToEmbed.map(item => ({
        id: item.chunk.id,
        content: formatChunkForEmbedding(item.chunk),
      }));
      
      const batchResult = await gemini.generateBatchEmbeddings({
        apiKey: config.geminiApiKey,
        contents,
        model: EMBEDDING_MODEL,
        batchSize: BATCH_SIZE,
        apiVersion: EMBEDDING_API_VERSION,
      });
      
      totalTokensUsed += batchResult.totalTokensUsed;
      
      // Process results and prepare for Pinecone
      const vectorsToUpsert: Array<{
        id: string;
        values: number[];
        metadata: Record<string, any>;
      }> = [];
      
      for (const embedding of batchResult.embeddings) {
        const item = chunksToEmbed.find(c => c.chunk.id === embedding.id);
        if (!item) continue;
        
        if (embedding.error) {
          errors.push({
            chunkId: embedding.id,
            error: embedding.error,
          });
        } else {
          embeddings.push({
            chunkId: embedding.id,
            embedding: embedding.embedding,
            model: EMBEDDING_MODEL,
            tokensUsed: embedding.tokensUsed,
          });
          
          // Prepare for Pinecone
          vectorsToUpsert.push({
            id: item.key,
            values: embedding.embedding,
            metadata: {
              chunkId: item.chunk.id,
              filePath: item.chunk.filePath,
              type: item.chunk.type,
              language: item.chunk.language,
              content: item.chunk.content,
              startLine: item.chunk.startLine,
              endLine: item.chunk.endLine,
              name: item.chunk.name,
              ...item.chunk.metadata,
              // Add file extension for filtering
              fileType: item.chunk.filePath.split('.').pop() || ''
            }
          });
        }
      }
      
      // Upsert to Pinecone
      if (vectorsToUpsert.length > 0) {
        await pineconeService.upsertVectors(userId, vectorsToUpsert);
      }
    }
    
    // Log progress
    logger.info(`Processed embedding batch ${Math.floor(i / BATCH_SIZE) + 1}/${Math.ceil(chunks.length / BATCH_SIZE)}`);
  }
  
  return {
    embeddings,
    errors,
    totalTokensUsed,
  };
}

/**
 * Format a code chunk for embedding generation
 */
function formatChunkForEmbedding(chunk: CodeChunk): string {
  let formatted = `File: ${chunk.filePath}\n`;
  formatted += `Type: ${chunk.type}\n`;
  
  if (chunk.name) {
    formatted += `Name: ${chunk.name}\n`;
  }
  
  if (chunk.metadata?.signature) {
    formatted += `Signature: ${chunk.metadata.signature}\n`;
  }
  
  if (chunk.metadata?.docstring) {
    formatted += `Documentation: ${chunk.metadata.docstring}\n`;
  }
  
  formatted += `\nCode:\n${chunk.content}`;
  
  return formatted;
}

/**
 * Generate embedding for a search query
 */
export async function generateQueryEmbedding(
  query: string,
  userId: string
): Promise<{
  embedding: number[];
  model: string;
  tokensUsed?: number;
  error?: string;
}> {
  // Wait for rate limit
  await rateLimiter.waitForSlot();
  
  // Generate embedding for the query
  const result = await gemini.generateEmbedding({
    apiKey: config.geminiApiKey,
    content: query,
    model: EMBEDDING_MODEL,
    apiVersion: EMBEDDING_API_VERSION,
  });
  
  if (result.error) {
    logger.error(`Failed to generate query embedding for query "${query}": ${result.error}`);
    return { embedding: [], model: EMBEDDING_MODEL, tokensUsed: 0, error: result.error };
  }
  
  return {
    embedding: result.embedding,
    model: result.model,
    tokensUsed: result.tokensUsed,
  };
}

export default {
  generateChunkEmbedding,
  generateBatchEmbeddings,
  generateQueryEmbedding,
}; 