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
const RATE_LIMIT = config.embeddingRateLimit || 10; // RPM (Requests Per Minute)
const BATCH_SIZE = config.embeddingBatchSize || 3; // Chunks per batch, aligned with Gemini API limits

class EmbeddingRateLimiter {
  private requests: number;
  private resetTime: number;
  private lastRequestTime: number;
  private minDelayBetweenRequests: number;

  constructor() {
    this.requests = 0;
    this.resetTime = Date.now() + 60000; // 1 minute from now
    this.lastRequestTime = 0;
    // Calculate delay based on the configured RATE_LIMIT
    this.minDelayBetweenRequests = 60000 / (config.embeddingRateLimit || 10); 

    logger.info(
      `EmbeddingRateLimiter initialized: ` +
        `Rate Limit: ${config.embeddingRateLimit || 10} RPM, ` +
        `Min Delay: ${this.minDelayBetweenRequests / 1000}s`
    );
  }

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
  }
  
  async waitForSlot(): Promise<void> {
    while (!(await this.checkLimit())) {
      const now = Date.now();
      const waitTime = Math.max(
        this.resetTime - now,
        this.minDelayBetweenRequests - (now - this.lastRequestTime)
      );
      logger.info(`Rate limit (${config.embeddingRateLimit || 10} RPM): waiting ${Math.ceil(waitTime/1000)}s before next request (${this.requests}/${config.embeddingRateLimit || 10} used)`);
      await new Promise(resolve => setTimeout(resolve, Math.min(waitTime + 100, 15000))); // Max 15s wait
    }
  }
}

// Instantiate the rate limiter
const embeddingRateLimiter = new EmbeddingRateLimiter();

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
  
  // Wait for a slot if rate limited
  await embeddingRateLimiter.waitForSlot();

  // Record the request (even if it fails, to count against the rate limit)
  const canRequest = await embeddingRateLimiter.checkLimit();
  if (!canRequest) {
    // This should ideally not happen if waitForSlot is effective, but as a safeguard:
    logger.warn(`Rate limit exceeded after waiting for chunk ${chunk.id}, aborting embedding.`);
    throw new Error('Rate limit exceeded');
  }
  
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
  userId: string,
  onProgress?: (progress: {
    completedChunks: number;
    totalChunks: number;
    currentBatchNumber: number;
    totalBatches: number;
    successfullyStoredInBatch: number;
    errorsInBatch: number;
    currentFileRelativePath?: string;
    fileStatus?: 'embedding_started' | 'embedding_progress' | 'file_completed' | 'file_error';
    fileErrorDetails?: string;
  }) => void
): Promise<{
  embeddings: EmbeddingResponse[];
  errors: Array<{ chunkId: string; error: string }>;
  totalTokensUsed: number;
  successfullyStored: number;
}> {
  const embeddings: EmbeddingResponse[] = [];
  const errors: Array<{ chunkId: string; error: string }> = [];
  let totalTokensUsed = 0;
  let successfullyStored = 0;
  
  const totalBatches = Math.ceil(chunks.length / BATCH_SIZE);
  logger.info(`Starting batch embedding for ${chunks.length} chunks in ${totalBatches} batches for user ${userId}`);
  
  // Wait for a slot before starting any batch processing
  await embeddingRateLimiter.waitForSlot();
  
  let currentFileForProgress: string | undefined = undefined;
  let overallProcessedChunks = 0;

  // Process chunks in batches
  for (let i = 0; i < chunks.length; i += BATCH_SIZE) {
    const currentBatchNumber = Math.floor(i / BATCH_SIZE) + 1;
    const batch = chunks.slice(i, i + BATCH_SIZE);
    let successfullyStoredInCurrentBatch = 0;
    let errorsInCurrentBatch = 0;

    logger.info(`Processing batch ${currentBatchNumber}/${totalBatches} (${batch.length} chunks)`);

    // Determine current file being processed for progress reporting
    if (batch.length > 0 && batch[0].filePath !== currentFileForProgress) {
      currentFileForProgress = batch[0].filePath;
      if (onProgress) {
        onProgress({
          completedChunks: overallProcessedChunks,
          totalChunks: chunks.length,
          currentBatchNumber,
          totalBatches,
          successfullyStoredInBatch: 0,
          errorsInBatch: 0,
          currentFileRelativePath: currentFileForProgress,
          fileStatus: 'embedding_started'
        });
      }
    }

    const chunksToEmbed: Array<{ chunk: CodeChunk; key: string }> = [];
    
    for (const chunk of batch) {
      const chunkKey = generateChunkKey(chunk);
      chunksToEmbed.push({ chunk, key: chunkKey });
    }
    
    if (chunksToEmbed.length > 0) {
      try {
        // Check rate limit before each batch request
        const canRequest = await embeddingRateLimiter.checkLimit();
        if (!canRequest) {
          logger.warn(`Rate limit hit during batch ${currentBatchNumber}, skipping remaining chunks in this batch.`);
          batch.forEach(c => errors.push({ chunkId: c.id, error: 'Rate limit hit, batch skipped' }));
          continue;
        }
        
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
        
        // Upsert to Pinecone and track successful storage
        if (vectorsToUpsert.length > 0) {
          try {
            await pineconeService.upsertVectors(userId, vectorsToUpsert);
            successfullyStored += vectorsToUpsert.length;
            logger.info(`Successfully stored ${vectorsToUpsert.length} vectors in Pinecone for batch ${currentBatchNumber}`);
          } catch (pineconeError) {
            logger.error(`Failed to store vectors in Pinecone for batch ${currentBatchNumber}:`, pineconeError);
            // Add errors for all vectors that failed to store
            vectorsToUpsert.forEach(vector => {
              const chunkId = vector.metadata.chunkId;
              errors.push({
                chunkId,
                error: `Failed to store in Pinecone: ${pineconeError instanceof Error ? pineconeError.message : String(pineconeError)}`
              });
            });
          }
        }
        
        // Report progress
        overallProcessedChunks += batch.length;
        if (onProgress) {
          onProgress({
            completedChunks: overallProcessedChunks,
            totalChunks: chunks.length,
            currentBatchNumber,
            totalBatches,
            successfullyStoredInBatch: successfullyStoredInCurrentBatch,
            errorsInBatch: errorsInCurrentBatch,
            currentFileRelativePath: currentFileForProgress,
            fileStatus: 'embedding_progress'
          });
        }
        
        logger.info(`Batch ${currentBatchNumber}/${totalBatches} complete: ${overallProcessedChunks}/${chunks.length} chunks processed so far, ${successfullyStored} stored in Pinecone`);

        // Check if the current file is completed in this batch
        if (currentFileForProgress) {
          const remainingChunksInFile = chunks.slice(i + batch.length).filter(c => c.filePath === currentFileForProgress);
          if (remainingChunksInFile.length === 0) {
            // All chunks for currentFileForProgress have been processed (or attempted)
            let fileHasErrors = false;
            const fileErrorMessages: string[] = [];

            batchResult.embeddings.forEach(embedding => {
              if (embedding.error) {
                const erroredChunk = chunksToEmbed.find(c => c.chunk.id === embedding.id);
                if (erroredChunk?.chunk.filePath === currentFileForProgress) {
                  fileHasErrors = true;
                  fileErrorMessages.push(`Chunk ${embedding.id}: ${embedding.error}`);
                }
              }
            });

            if (onProgress) {
              onProgress({
                completedChunks: overallProcessedChunks,
                totalChunks: chunks.length,
                currentBatchNumber,
                totalBatches,
                successfullyStoredInBatch: successfullyStoredInCurrentBatch,
                errorsInBatch: errorsInCurrentBatch, // This still refers to batch-level errors, not file-specific from this logic
                currentFileRelativePath: currentFileForProgress,
                fileStatus: fileHasErrors ? 'file_error' : 'file_completed',
                fileErrorDetails: fileHasErrors ? fileErrorMessages.join('; ') : undefined
              });
            }
            currentFileForProgress = undefined; // Reset for the next file
          }
        }

      } catch (batchError) {
        logger.error(`Error processing batch ${currentBatchNumber}:`, batchError);
        // Add errors for all chunks in this batch
        chunksToEmbed.forEach(item => {
          errors.push({
            chunkId: item.chunk.id,
            error: `Batch processing failed: ${batchError instanceof Error ? batchError.message : String(batchError)}`
          });
        });
      }
    }
  }
  
  logger.info(`Batch embedding complete: ${embeddings.length} successful, ${errors.length} errors, ${successfullyStored} stored in Pinecone, ${totalTokensUsed} tokens used`);
  
  return {
    embeddings,
    errors,
    totalTokensUsed,
    successfullyStored
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
  // Wait for a slot if rate limited
  await embeddingRateLimiter.waitForSlot();

  // Record the request
  const canRequest = await embeddingRateLimiter.checkLimit();
  if (!canRequest) {
    logger.warn(`Rate limit exceeded for query embedding, aborting.`);
    return { embedding: [], model: EMBEDDING_MODEL, tokensUsed: 0, error: 'Rate limit exceeded' };
  }
  
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