// Copyright (c) COODE AI EDITOR. All rights reserved.
// Licensed under the MIT License. See License.txt in the project root for license information.

import logger from '@repo/logger';
import { config } from './config';
import * as mistral from './mistral';
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
const EMBEDDING_MODEL = 'codestral-embed';
const BATCH_SIZE = config.embeddingBatchSize || 50; // Increased batch size for Mistral API

class EmbeddingRateLimiter {
  private requests: number;
  private resetTime: number;
  private lastRequestTime: number;

  constructor() {
    this.requests = 0;
    this.resetTime = Date.now() + 1000; // 1 second window for Mistral (6 RPS limit)
    this.lastRequestTime = 0;

    logger.info(
      `EmbeddingRateLimiter initialized: Will use 6 requests per second limit for Mistral API`
    );
  }

  private getMinDelayBetweenRequests(): number {
    // Mistral allows 6 requests per second
    return 1000 / 6; // ~166ms between requests
  }

  async checkLimit(): Promise<boolean> {
    const now = Date.now();
    if (now > this.resetTime) {
      this.requests = 0;
      this.resetTime = now + 1000; // Reset every second
    }

    // Mistral allows 6 requests per second
    if (this.requests >= 6) {
      return false;
    }
    
    // Check minimum delay between requests
    const timeSinceLastRequest = now - this.lastRequestTime;
    if (timeSinceLastRequest < this.getMinDelayBetweenRequests()) {
      return false;
    }
    
    // If we are here, it means we can make a request.
    return true;
  }

  // Call this method *before* making an actual API call to consume a slot.
  private consumeSlot(): void {
    this.requests++;
    this.lastRequestTime = Date.now();
  }
  
  async waitForSlot(): Promise<void> {
    while (true) {
        const now = Date.now();
        const currentRateLimit = 6; // 6 requests per second for Mistral
        let minDelay = this.getMinDelayBetweenRequests();

        if (now > this.resetTime) {
            this.requests = 0;
            this.resetTime = now + 1000;
        }

        if (this.requests < currentRateLimit) {
            const timeSinceLastRequest = now - this.lastRequestTime;
            if (timeSinceLastRequest >= minDelay) {
                this.consumeSlot(); // Consume the slot as we are granting it
                return; // Slot available
            }
        }

        const waitTimeForReset = this.resetTime - now;
        const waitForMinDelay = minDelay - (now - this.lastRequestTime);
        const waitTime = Math.max(0, Math.min(waitTimeForReset, waitForMinDelay)); // Ensure non-negative wait time
        
        logger.info(`Rate limit (${currentRateLimit} RPS): waiting ${Math.ceil(waitTime)}ms before next request (${this.requests}/${currentRateLimit} used)`);
        await new Promise(resolve => setTimeout(resolve, Math.min(waitTime + 10, 1000))); // Max 1s wait, add 10ms buffer
    }
  }
}

// Instantiate the rate limiter
const embeddingRateLimiter = new EmbeddingRateLimiter();

/**
 * Generate a unique key for a code chunk
 * Now uses the file path as part of the key for better traceability
 */
function generateChunkKey(chunk: CodeChunk): string {
  // Create a base path ID that's safe for storage
  const safeFilePath = chunk.filePath.replace(/[^a-zA-Z0-9_\-\.]/g, '_');
  
  // Still include a hash for uniqueness in case of content changes within same lines
  const hash = crypto.createHash('sha256');
  hash.update(chunk.content);
  hash.update(chunk.type);
  hash.update(String(chunk.startLine));
  hash.update(String(chunk.endLine));
  const contentHash = hash.digest('hex').substring(0, 12); // Shortened hash
  
  return `${safeFilePath}_L${chunk.startLine}-${chunk.endLine}_${contentHash}`;
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

  // Generate new embedding with Mistral
  const result = await mistral.generateEmbedding({
    apiKey: config.mistralApiKey,
    content: formatChunkForEmbedding(chunk),
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
  
  // await embeddingRateLimiter.waitForSlot(); // Removed from here
  
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
        // ADDED: Wait for slot before each actual batch API call
        await embeddingRateLimiter.waitForSlot();

        // Generate embeddings for uncached chunks
        const contents = chunksToEmbed.map(item => ({
          id: item.chunk.id,
          content: formatChunkForEmbedding(item.chunk),
        }));
        
        const batchResult = await mistral.generateBatchEmbeddings({
          apiKey: config.mistralApiKey,
          contents,
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
export function formatChunkForEmbedding(chunk: CodeChunk): string {
  // Basic formatting for code chunks
  let formattedContent = '';
  
  // Add file information with path as the primary identifier
  formattedContent += `File: ${chunk.filePath}\n`;
  
  if (chunk.language) {
    formattedContent += `Language: ${chunk.language}\n`;
  }
  
  // Add type and name if available
  if (chunk.type) {
    formattedContent += `Type: ${chunk.type}\n`;
  }
  if (chunk.name) {
    formattedContent += `Name: ${chunk.name}\n`;
  }
  
  // Add line numbers
  formattedContent += `Lines: ${chunk.startLine}-${chunk.endLine}\n\n`;
  
  // Include chunk ID for traceability
  formattedContent += `ChunkID: ${chunk.id}\n\n`;
  
  // Add actual content
  formattedContent += chunk.content;
  
  return formattedContent;
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

  // Generate embedding for the query using Mistral's Codestral Embed API
  const result = await mistral.generateEmbedding({
    apiKey: config.mistralApiKey,
    content: query,
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