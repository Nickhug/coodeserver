import { S3Client, PutObjectCommand, GetObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import logger from '@repo/logger';
import { config } from './config';
import * as gemini from '@repo/ai-providers';
import { CodeChunk } from '@repo/types';
import crypto from 'crypto';

// Define EmbeddingResponse locally
interface EmbeddingResponse {
  chunkId: string;
  embedding: number[];
  model: string;
  tokensUsed?: number;
}

// Initialize S3 client for R2
let s3Client: S3Client | null = null;

if (config.r2AccountId && config.r2AccessKeyId && config.r2SecretAccessKey && config.r2Endpoint) {
  s3Client = new S3Client({
    region: 'auto',
    endpoint: config.r2Endpoint,
    credentials: {
      accessKeyId: config.r2AccessKeyId,
      secretAccessKey: config.r2SecretAccessKey,
    },
  });
  logger.info('R2 storage client initialized');
} else {
  logger.warn('R2 storage not configured, embeddings will not be persisted');
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
 * Store embedding in R2
 */
async function storeEmbedding(
  chunkId: string,
  embedding: number[],
  metadata: Record<string, any>
): Promise<boolean> {
  if (!s3Client) {
    logger.warn('R2 storage not configured, skipping storage');
    return false;
  }
  
  try {
    const key = `embeddings/${chunkId}.json`;
    const data = {
      embedding,
      metadata,
      timestamp: new Date().toISOString(),
    };
    
    await s3Client.send(new PutObjectCommand({
      Bucket: config.r2BucketName,
      Key: key,
      Body: JSON.stringify(data),
      ContentType: 'application/json',
    }));
    
    logger.debug(`Stored embedding for chunk ${chunkId} in R2`);
    return true;
  } catch (error) {
    logger.error(`Failed to store embedding in R2: ${error}`);
    return false;
  }
}

/**
 * Retrieve embedding from R2
 */
async function getStoredEmbedding(chunkId: string): Promise<number[] | null> {
  if (!s3Client) {
    return null;
  }
  
  try {
    const key = `embeddings/${chunkId}.json`;
    
    // Check if object exists
    try {
      await s3Client.send(new HeadObjectCommand({
        Bucket: config.r2BucketName,
        Key: key,
      }));
    } catch (error: any) {
      if (error.name === 'NotFound') {
        return null;
      }
      throw error;
    }
    
    // Get object
    const response = await s3Client.send(new GetObjectCommand({
      Bucket: config.r2BucketName,
      Key: key,
    }));
    
    if (!response.Body) {
      return null;
    }
    
    const bodyString = await response.Body.transformToString();
    const data = JSON.parse(bodyString);
    
    return data.embedding;
  } catch (error) {
    logger.error(`Failed to retrieve embedding from R2: ${error}`);
    return null;
  }
}

/**
 * Generate embedding for a single code chunk
 */
export async function generateChunkEmbedding(
  chunk: CodeChunk,
  userId: string
): Promise<EmbeddingResponse> {
  const chunkKey = generateChunkKey(chunk);
  
  // Check if we have a cached embedding
  const cachedEmbedding = await getStoredEmbedding(chunkKey);
  if (cachedEmbedding) {
    logger.debug(`Using cached embedding for chunk ${chunk.id}`);
    return {
      chunkId: chunk.id,
      embedding: cachedEmbedding,
      model: EMBEDDING_MODEL,
      tokensUsed: 0, // No tokens used for cached result
    };
  }
  
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
  
  // Store in R2
  await storeEmbedding(chunkKey, result.embedding, {
    chunkId: chunk.id,
    filePath: chunk.filePath,
    type: chunk.type,
    language: chunk.language,
    userId,
  });
  
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
    
    // Check cache and prepare chunks that need embedding
    const chunksToEmbed: Array<{ chunk: CodeChunk; key: string }> = [];
    
    for (const chunk of batch) {
      const chunkKey = generateChunkKey(chunk);
      const cachedEmbedding = await getStoredEmbedding(chunkKey);
      
      if (cachedEmbedding) {
        embeddings.push({
          chunkId: chunk.id,
          embedding: cachedEmbedding,
          model: EMBEDDING_MODEL,
          tokensUsed: 0,
        });
      } else {
        chunksToEmbed.push({ chunk, key: chunkKey });
      }
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
      
      // Process results
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
          
          // Store in R2
          await storeEmbedding(item.key, embedding.embedding, {
            chunkId: item.chunk.id,
            filePath: item.chunk.filePath,
            type: item.chunk.type,
            language: item.chunk.language,
            userId,
          });
        }
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

export default {
  generateChunkEmbedding,
  generateBatchEmbeddings,
}; 