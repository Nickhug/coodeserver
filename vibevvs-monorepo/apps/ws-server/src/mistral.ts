// Copyright (c) COODE AI EDITOR. All rights reserved.
// Licensed under the MIT License. See License.txt in the project root for license information.

import { Mistral } from '@mistralai/mistralai';
import { config } from './config';
import logger from '@repo/logger';

// Constants
const EMBEDDING_MODEL = 'codestral-embed';
const OUTPUT_DIMENSION = 3072; // Maximum dimension supported by the model

/**
 * Generate an embedding for a single text input
 */
export async function generateEmbedding({
  apiKey,
  content,
}: {
  apiKey: string;
  content: string;
}): Promise<{
  embedding: number[];
  model: string;
  tokensUsed?: number;
  error?: string;
}> {
  try {
    const client = new Mistral({ apiKey });
    
    const response = await client.embeddings.create({
      model: EMBEDDING_MODEL,
      outputDimension: OUTPUT_DIMENSION,
      inputs: [content],
    });
    
    if (!response.data || response.data.length === 0 || !response.data[0].embedding) {
      return {
        embedding: [],
        model: EMBEDDING_MODEL,
        error: 'No embedding returned from Mistral API',
      };
    }
    
    return {
      embedding: response.data[0].embedding,
      model: response.model,
      tokensUsed: response.usage?.totalTokens,
    };
  } catch (error) {
    logger.error(`Mistral embedding generation failed: ${error instanceof Error ? error.message : String(error)}`);
    return {
      embedding: [],
      model: EMBEDDING_MODEL,
      error: `Mistral API error: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/**
 * Generate embeddings for multiple text inputs in batch
 */
export async function generateBatchEmbeddings({
  apiKey,
  contents,
}: {
  apiKey: string;
  contents: Array<{ id: string; content: string }>;
  batchSize?: number; // Not used here as we handle batching differently
}): Promise<{
  embeddings: Array<{
    id: string;
    embedding: number[];
    tokensUsed?: number;
    error?: string;
  }>;
  totalTokensUsed: number;
}> {
  try {
    const client = new Mistral({ apiKey });
    
    // Extract content from the contents array
    const inputs = contents.map((item) => item.content);
    
    // Generate embeddings
    const response = await client.embeddings.create({
      model: EMBEDDING_MODEL,
      outputDimension: OUTPUT_DIMENSION,
      inputs,
    });
    
    // Map response back to the original IDs
    const embeddings = contents.map((item, index) => {
      if (!response.data || !response.data[index] || !response.data[index].embedding) {
        return {
          id: item.id,
          embedding: [],
          error: `No embedding returned for item ${item.id}`,
        };
      }
      
      return {
        id: item.id,
        embedding: response.data[index].embedding,
        tokensUsed: response.usage ? Math.ceil(response.usage.totalTokens / inputs.length) : undefined,
      };
    });
    
    return {
      embeddings,
      totalTokensUsed: response.usage?.totalTokens || 0,
    };
  } catch (error) {
    logger.error(`Mistral batch embedding generation failed: ${error instanceof Error ? error.message : String(error)}`);
    
    // Return error for all items in the batch
    return {
      embeddings: contents.map((item) => ({
        id: item.id,
        embedding: [],
        error: `Mistral API error: ${error instanceof Error ? error.message : String(error)}`,
      })),
      totalTokensUsed: 0,
    };
  }
}

/**
 * List available Mistral models (for compatibility with other provider interfaces)
 */
export async function listModels(apiKey: string): Promise<any[]> {
  return [
    { id: 'codestral-embed', name: 'Codestral Embed' },
  ];
}
