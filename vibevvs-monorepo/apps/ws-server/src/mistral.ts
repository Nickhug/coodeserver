// Copyright (c) COODE AI EDITOR. All rights reserved.
// Licensed under the MIT License. See License.txt in the project root for license information.

import { Mistral } from '@mistralai/mistralai';
import { config } from './config';
import logger from '@repo/logger';
// Dynamically import node-fetch as it is an ES Module

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
 * Process a Fill-In-Middle (FIM) request using Codestral model
 */
export async function processFIM({
  apiKey,
  prefix,
  suffix,
  model = 'codestral-latest',
  temperature = 0.2,
  maxTokens = 512,
  stream = true,
  stopSequences = [],
  onStream,
  onFinal,
  onError,
}: {
  apiKey: string;
  prefix: string;
  suffix: string;
  model?: string;
  temperature?: number;
  maxTokens?: number;
  stream?: boolean;
  stopSequences?: string[];
  onStream?: (chunk: string) => void;
  onFinal?: (text: string) => void;
  onError?: (error: Error) => void;
}): Promise<void> {
  try {
    const { default: fetch } = await import('node-fetch');
    logger.info(`Mistral Codestral FIM request: model=${model}, stream=${stream}, temp=${temperature}`);
    
    // Validate inputs
    if (!prefix && !suffix) {
      throw new Error('Either prefix or suffix must be provided');
    }

    // Log token length for diagnostics (approximate)
    logger.debug(`Mistral FIM approximate input sizes: prefix=${prefix.length / 4} chars, suffix=${suffix.length / 4} chars`);
    
    // FIM is not directly supported by the SDK, so we need to use the raw API endpoint
    // Use the enterprise API endpoint for FIM
    const apiUrl = 'https://api.mistral.ai/v1/fim/completions';
    
    const requestBody = {
      model,
      prefix: prefix || '',
      suffix: suffix || '',
      max_tokens: maxTokens,
      temperature,
      stop: stopSequences,
      stream
    };
    
    if (stream && onStream) {
      // Process as stream
      try {
        let fullResponse = '';
        
        const response = await fetch(apiUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`
          },
          body: JSON.stringify(requestBody)
        });
        
        if (!response.ok) {
          const errorText = await response.text();
          throw new Error(`Mistral API error: ${response.status} ${errorText}`);
        }
        
        if (!response.body) {
          throw new Error('Response body is null');
        }
        
        // Process the stream
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          
          const chunk = decoder.decode(value, { stream: true });
          const lines = chunk.split('\n').filter(line => line.trim() !== '');
          
          for (const line of lines) {
            if (line.startsWith('data: ')) {
              const jsonData = line.substring(6);
              if (jsonData === '[DONE]') continue;
              
              try {
                const data = JSON.parse(jsonData);
                if (data.choices && data.choices.length > 0) {
                  const content = data.choices[0].text || '';
                  if (content) {
                    fullResponse += content;
                    onStream(content);
                  }
                }
              } catch (e) {
                logger.error(`Failed to parse JSON from stream: ${e instanceof Error ? e.message : String(e)}`);
              }
            }
          }
        }
        
        if (onFinal) {
          onFinal(fullResponse);
        }
      } catch (streamError) {
        logger.error(`Mistral FIM stream error: ${streamError instanceof Error ? streamError.message : String(streamError)}`);
        if (onError) {
          onError(streamError instanceof Error ? streamError : new Error(String(streamError)));
        }
      }
    } else {
      // Process as non-stream
      const response = await fetch(apiUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`
        },
        body: JSON.stringify({...requestBody, stream: false})
      });
      
      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Mistral API error: ${response.status} ${errorText}`);
      }
      
      const data = await response.json();
      const completionText = data.choices && data.choices.length > 0 ? data.choices[0].text || '' : '';
      
      if (onFinal) {
        onFinal(completionText);
      }
    }
  } catch (error) {
    logger.error(`Mistral FIM error: ${error instanceof Error ? error.message : String(error)}`);
    if (onError) {
      onError(error instanceof Error ? error : new Error(String(error)));
    }
  }
}

/**
 * List available Mistral models (for compatibility with other provider interfaces)
 */
export async function listModels(apiKey: string): Promise<any[]> {
  return [
    { id: 'codestral-embed', name: 'Codestral Embed' },
    { id: 'codestral-latest', name: 'Codestral Latest', capabilities: ['fim', 'completion'] },
  ];
}
