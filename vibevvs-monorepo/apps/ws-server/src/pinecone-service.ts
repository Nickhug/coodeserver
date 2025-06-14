/*---------------------------------------------------------------------------------------------
 *  Copyright (c) COODE AI EDITOR. All rights reserved.
 *--------------------------------------------------------------------------------------------*/
import { Pinecone, Index, IndexStatsDescription } from '@pinecone-database/pinecone';
import logger from '@repo/logger';
import { config } from './config';
import { CodeChunk } from '@repo/types';

// Define a base metadata type that Pinecone's Index type expects
export type PineconeRecordMetadata = Record<string, string | number | boolean | string[]>;

// Import modules using require (with type assertions)
let pineconeClient: Pinecone | null = null;
let pineconeIndex: Index<PineconeRecordMetadata> | null = null;
let initializationPromise: Promise<void> | null = null;

// Define type for text-based vector records (for integrated embedding model)
// This is the structure produced by document-processing-service
export type PineconeTextRecord = {
  id: string; // Unique ID for the record
  chunk_text: string; // The raw text content to be embedded by Pinecone
  metadata: PineconeRecordMetadata; // Other metadata associated with the chunk
};

// PineconeRecordWithChunkText type is no longer needed, direct mapping will be used.

// Debug logging for API key
logger.info(`Pinecone configuration check:`);
logger.info(`- API Key present: ${config.pineconeApiKey ? 'YES' : 'NO'}`);
logger.info(`- API Key length: ${config.pineconeApiKey ? config.pineconeApiKey.length : 0}`);
logger.info(`- API Key prefix: ${config.pineconeApiKey ? config.pineconeApiKey.substring(0, 8) + '...' : 'N/A'}`);
logger.info(`- Index Name: ${config.pineconeIndexName}`);
logger.info(`- Base Namespace: ${config.pineconeNamespace}`);

if (config.pineconeApiKey) {
  try {
    pineconeClient = new Pinecone({
      apiKey: config.pineconeApiKey,
    });
    logger.info('Pinecone client initialized successfully');
  } catch (error) {
    logger.error('Failed to initialize Pinecone client:', error);
  }
} else {
  logger.warn('Pinecone API key not configured, vector search will not work');
}

/**
 * Generate user-specific namespace for efficient vector storage
 * Format: "user-{userId}" or "user-{userId}-{baseNamespace}" if base namespace is provided
 * 
 * @param userId The user ID
 * @param workspaceId The workspace ID (not used in namespace anymore, but kept for backward compatibility)
 * @returns A properly formatted namespace string for Pinecone
 */
function getUserNamespace(userId: string, workspaceId?: string): string {
  if (!userId) {
    throw new Error('User ID is required for namespace generation');
  }
  
  // Base namespace from config
  const baseNamespace = config.pineconeNamespace;
  
  // Always use a single namespace per user (workspaceId will be used in metadata filters)
  const namespace = `user-${userId}`;
  return baseNamespace ? `${namespace}-${baseNamespace}` : namespace;
}

/**
 * Export getUserNamespace for external use
 */
export { getUserNamespace };

// Initialize index connection
async function initializeIndex(): Promise<void> {
  // If initialization is already in progress, wait for it to complete
  if (initializationPromise) {
    logger.debug('Initialization already in progress, awaiting completion...');
    await initializationPromise;
    // After awaiting, if pineconeIndex is now valid, we can return.
    // This handles cases where another call completed initialization successfully.
    if (pineconeIndex) {
      try {
        await pineconeIndex.describeIndexStats(); // Quick test
        logger.debug('Pinecone index is already initialized and valid after awaiting promise.');
        return;
      } catch (e) {
        logger.warn('Pinecone index became invalid after awaiting promise, will re-initialize.', e);
        pineconeIndex = null; // Force re-initialization
      }
    }
  }

  // If index is already initialized and working, skip
  if (pineconeIndex) {
    try {
      // Test the connection to make sure it's still valid
      await pineconeIndex.describeIndexStats();
      logger.debug('Pinecone index already initialized and valid.');
      return; 
    } catch (error) {
      logger.warn('Existing Pinecone index connection test failed, reinitializing...', error);
      pineconeIndex = null; // Reset the index reference to force reinitialization
    }
  }

  // Start new initialization
  initializationPromise = (async () => {
    if (!pineconeClient) {
      logger.error('Pinecone client not initialized - check API key configuration');
      throw new Error('Pinecone client not initialized');
    }

    try {
      logger.info('Starting new Pinecone index initialization...');

      // Check if index exists, if not create it
      const indexes = await pineconeClient.listIndexes();
      const indexExists = indexes.indexes?.some(idx => idx.name === config.pineconeIndexName);

      if (!indexExists) {
        logger.info(`Creating Pinecone serverless index for multitenancy: ${config.pineconeIndexName}`);
        try {
          await pineconeClient.createIndex({
            name: config.pineconeIndexName,
            dimension: 3072, // Gemini text-embedding-004 dimension (3072 for gemini-embedding-001)
            metric: 'cosine',
            spec: {
              serverless: {
                cloud: 'aws',
                region: 'us-east-1'
              }
            }
          });

          // Wait for index to be ready
          logger.info('Waiting for serverless index to be ready...');
          await new Promise(resolve => setTimeout(resolve, 15000)); // Increased wait time
          logger.info('Serverless index should be ready now');
        } catch (createError: any) {
          if (createError.message?.includes('already exists')) {
            logger.info('Index already exists, continuing...');
          } else {
            logger.error('Failed to create Pinecone index:', createError);
            throw createError;
          }
        }
      } else {
        logger.info(`Pinecone index ${config.pineconeIndexName} already exists`);

        // Check if existing index has correct dimensions
        try {
          const tempIndex = pineconeClient.index(config.pineconeIndexName);
          const stats = await tempIndex.describeIndexStats();

          // Check if the index has the wrong dimensions
          if (stats.dimension && stats.dimension !== 3072) {
            logger.error(`Index ${config.pineconeIndexName} has wrong dimensions: ${stats.dimension} (expected 3072)`);
            logger.error('You need to delete the existing index and let the system recreate it with correct dimensions');
            throw new Error(`Index dimension mismatch: found ${stats.dimension}, expected 3072. Please delete the index in Pinecone console.`);
          }

          logger.info(`Index dimensions verified: ${stats.dimension || 'unknown'}`);
        } catch (statsError: any) {
          if (statsError.message?.includes('dimension mismatch')) {
            throw statsError; // Re-throw dimension errors
          }
          logger.warn('Could not verify index dimensions, proceeding anyway:', statsError.message);
        }
      }

      // Connect to the index
      pineconeIndex = pineconeClient.index(config.pineconeIndexName);

      // Test the connection
      const testStats: IndexStatsDescription = await pineconeIndex.describeIndexStats();
      logger.info(`Connected to Pinecone serverless index: ${config.pineconeIndexName}`);
      logger.info(`Index stats: ${testStats.totalRecordCount || 0} total vectors, ${Object.keys(testStats.namespaces || {}).length} namespaces`);
      if (testStats.namespaces && Object.keys(testStats.namespaces).length > 0) {
        logger.info(`Existing namespaces: ${Object.keys(testStats.namespaces).join(', ')}`);
      }
      logger.info('Multitenancy enabled: Each user gets their own namespace for data isolation');
    } catch (testError: any) {
      logger.error('Failed to test Pinecone index connection:', testError);
      pineconeIndex = null; // Reset on failure
      throw testError;
    }
  })().finally(() => {
    // Reset the promise once initialization is complete (either success or failure)
    // This allows for future re-initialization attempts if needed.
    logger.debug(`Initialization attempt finished. Resetting initializationPromise.`);
    initializationPromise = null;
  });

  await initializationPromise; // Wait for the current initialization to complete
}

interface VectorSearchResult {
  chunk: CodeChunk;
  score: number;
  highlights?: string[];
}

interface SearchOptions {
  limit?: number;
  filters?: any;
  workspaceId?: string; // Optional workspace ID for namespace isolation
}

/**
 * Upsert vectors to Pinecone using user-specific namespace for multitenancy
 * @param userId The user ID for namespace isolation
 * @param vectors Array of vectors to upsert
 * @param workspaceId Optional workspace ID to store in metadata for filtering
 */
/**
 * Upsert text records to Pinecone using the integrated embedding model
 * This function is used for document indexing with Pinecone's text-to-vector capability
 * 
 * @param indexName The name of the Pinecone index with integrated embedding model
 * @param records Array of text records to upsert (Pinecone will generate embeddings)
 */
import axios from 'axios'; // Import axios for direct API calls

// ... (keep existing imports and config)

export async function upsertTextRecords(
  indexName: string,
  records: Array<PineconeTextRecord>
): Promise<void> {
  await initializeIndex(); // Ensures pineconeClient is initialized
  if (!pineconeClient) {
    throw new Error('Pinecone client not initialized for fetching index details.');
  }
  if (!config.pineconeApiKey) {
    throw new Error('Pinecone API key not configured.');
  }

  const namespace = ''; // Using an empty string to target the default namespace

  try {
    // Get the host for the index
    const indexDescription = await pineconeClient.describeIndex(indexName);
    if (!indexDescription || !indexDescription.host) {
      throw new Error(`Could not retrieve host for index ${indexName}. Description: ${JSON.stringify(indexDescription)}`);
    }
    const host = indexDescription.host;
    const apiUrl = `https://${host}/records/namespaces/${namespace}/upsert`;

    logger.info(`Upserting ${records.length} text records to index ${indexName} (host: ${host}), namespace '${namespace}' via direct API call.`);

    const batchSize = 50; // Adjust batch size as needed for direct API calls
    for (let i = 0; i < records.length; i += batchSize) {
      const batch = records.slice(i, i + batchSize);

      if (i === 0 && batch.length > 0) {
        const firstRecord = batch[0];
        logger.info(`First record in batch to upsert (example): _id: ${firstRecord.id}, chunk_text length: ${firstRecord.chunk_text.length}, metadata keys: ${Object.keys(firstRecord.metadata).join(', ')}`);
      }

      const recordsForApi = batch.map(record => ({
        _id: record.id,
        chunk_text: record.chunk_text,
        ...record.metadata
      }));

      // Convert the batch of records to NDJSON format
      const ndjsonBody = recordsForApi.map(record => JSON.stringify(record)).join('\n');

      try {
        await axios.post(apiUrl, ndjsonBody, {
          headers: {
            'Api-Key': config.pineconeApiKey,
            'Content-Type': 'application/x-ndjson',
            'Accept': 'application/json' // Optional: specify what response format we accept
          }
        });
        logger.info(`Batch ${Math.floor(i / batchSize) + 1}/${Math.ceil(records.length / batchSize)} successfully upserted to ${indexName}, namespace '${namespace}'.`);
      } catch (apiError: any) {
        let errorMessage = `Direct API call failed for batch ${Math.floor(i / batchSize) + 1}`;
        if (axios.isAxiosError(apiError) && apiError.response) {
          errorMessage += `: ${apiError.response.status} ${apiError.response.statusText} - ${JSON.stringify(apiError.response.data)}`;
        } else {
          errorMessage += `: ${(apiError as Error).message}`;
        }
        logger.error(errorMessage, apiError);
        throw new Error(errorMessage);
      }
    }

    logger.info(`Successfully initiated upsert for ${records.length} text records to index ${indexName}, namespace '${namespace}' via direct API.`);
  } catch (error) {
    logger.error(`Error in upsertTextRecords (direct API) for index ${indexName}, namespace '${namespace}':`, error);
    // Ensure the re-thrown error is a standard Error object
    if (error instanceof Error) {
      throw error;
    }
    throw new Error(`Failed to upsert text records via direct API: ${String(error)}`);
  }
}

/**
 * Upsert vectors to Pinecone using user-specific namespace for multitenancy
 * @param userId The user ID for namespace isolation
 * @param vectors Array of vectors to upsert
 * @param workspaceId Optional workspace ID to store in metadata for filtering
 */
export async function upsertVectors(
  userId: string,
  vectors: Array<{
    id: string;
    values: number[];
    metadata: Record<string, any>;
  }>,
  workspaceId?: string
): Promise<void> {
  await initializeIndex();

  if (!pineconeIndex) {
    throw new Error('Pinecone index not initialized');
  }

  try {
    // Get user-specific namespace for multitenancy
    const userNamespace = getUserNamespace(userId);

    // Add workspaceId to metadata for filtering within the user's namespace
    const vectorsForNamespace = vectors.map(v => ({
      ...v,
      metadata: {
        ...v.metadata,
        // Keep userId in metadata for backwards compatibility and debugging
        userId,
        // Add workspaceId for filtering vectors by workspace
        workspaceId: workspaceId || 'default',
        // Add tenant info for additional context
        tenant: userNamespace
      }
    }));

    // Upsert in optimized batches to user's dedicated namespace
    // Pinecone allows up to 1000 vectors per batch with a 2MB limit
    const MAX_VECTORS_PER_BATCH = 1000;
    const MAX_BATCH_SIZE_BYTES = 2 * 1024 * 1024; // 2MB
    
    // Dynamic batch sizing based on payload size
    const batchVectors: typeof vectorsForNamespace[] = [];
    let currentBatch: typeof vectorsForNamespace = [];
    let currentBatchSize = 0;
    
    for (const vector of vectorsForNamespace) {
      // Estimate size of this vector (values array + metadata)
      // vector.values is a Float32Array of numbers (4 bytes each)
      const valuesSize = vector.values.length * 4;
      const metadataSize = JSON.stringify(vector.metadata).length * 2; // Unicode chars ~2 bytes
      const idSize = vector.id.length * 2;
      const estimatedVectorSize = valuesSize + metadataSize + idSize;
      
      // If adding this vector would exceed batch limits, push current batch and start a new one
      if (currentBatch.length >= MAX_VECTORS_PER_BATCH || 
          currentBatchSize + estimatedVectorSize > MAX_BATCH_SIZE_BYTES) {
        if (currentBatch.length > 0) {
          batchVectors.push([...currentBatch]);
          currentBatch = [];
          currentBatchSize = 0;
        }
      }
      
      // Add vector to current batch
      currentBatch.push(vector);
      currentBatchSize += estimatedVectorSize;
    }
    
    // Add the last batch if not empty
    if (currentBatch.length > 0) {
      batchVectors.push(currentBatch);
    }
    
    logger.info(`Optimized ${vectorsForNamespace.length} vectors into ${batchVectors.length} batches for upserting`);
    
    // Process all batches with some parallelism, but not too much to avoid overwhelming Pinecone
    const PARALLEL_UPSERTS = 2;
    for (let i = 0; i < batchVectors.length; i += PARALLEL_UPSERTS) {
      const batchPromises = [];
      for (let j = 0; j < PARALLEL_UPSERTS && i + j < batchVectors.length; j++) {
        const batchIndex = i + j;
        const batch = batchVectors[batchIndex];
        batchPromises.push(
          (async () => {
            await pineconeIndex.namespace(userNamespace).upsert(batch);
            logger.debug(`Upserted optimized batch ${batchIndex + 1}/${batchVectors.length} with ${batch.length} vectors to namespace ${userNamespace}`);
          })()
        );
      }
      await Promise.all(batchPromises);
    }

    logger.info(`Successfully upserted ${vectors.length} vectors for user ${userId} in namespace ${userNamespace}`);
  } catch (error) {
    logger.error(`Error upserting vectors to Pinecone for user ${userId}:`, error);
    throw error;
  }
}

/**
 * Search user's codebase using vector similarity in their dedicated namespace
 */
export async function searchUserCodebase(
  userId: string,
  queryEmbedding: number[],
  options: SearchOptions = {}
): Promise<VectorSearchResult[]> {
  await initializeIndex();

  if (!pineconeIndex) {
    logger.error('Pinecone index not initialized');
    return [];
  }

  const limit = options.limit || 10;
  const userNamespace = getUserNamespace(userId);

  try {
    // Always use the user's single namespace, regardless of workspace
    const namespace = getUserNamespace(userId);
    
    // Build filter for additional filtering within the user's namespace
    const filter: any = {};
    
    // If workspaceId is provided, add it to the filter
    if (options.workspaceId) {
      filter.workspaceId = options.workspaceId;
    }

    if (options.filters) {
      const { fileTypes, paths, languages } = options.filters;

      if (fileTypes && fileTypes.length > 0) {
        filter.fileType = { $in: fileTypes };
      }

      if (paths && paths.length > 0) {
        // Create an OR condition for path matching
        filter.$or = paths.map((path: string) => ({
          filePath: { $contains: path }
        }));
      }
      
      if (languages && languages.length > 0) {
        filter.language = { $in: languages };
      }
    }
    
    // Query Pinecone in user's dedicated namespace
    const queryResponse = await pineconeIndex.namespace(namespace).query({
      vector: queryEmbedding,
      topK: limit,
      filter: Object.keys(filter).length > 0 ? filter : undefined,
      includeMetadata: true,
      includeValues: false
    });
    
    // Convert results to our format
    const vectorResults: VectorSearchResult[] = [];

    if (queryResponse.matches) {
      for (const match of queryResponse.matches) {
        if (match.metadata) {
          const chunk: CodeChunk = {
            id: match.id,
            filePath: match.metadata.filePath as string,
            startLine: match.metadata.startLine as number || 0,
            endLine: match.metadata.endLine as number || 0,
            content: match.metadata.content as string || '',
            type: match.metadata.type as any,
            language: match.metadata.language as string,
            name: match.metadata.name as string,
            metadata: match.metadata.metadata as any || {}
          };

          vectorResults.push({
            chunk,
            score: match.score || 0,
            highlights: []
          });
        }
      }
    }

    logger.info(`Vector search completed: found ${vectorResults.length} results for user ${userId} in namespace ${namespace}`);
    return vectorResults;

  } catch (error: any) {
    const namespace = getUserNamespace(userId, options.workspaceId);
    logger.error(`Error performing vector search for user ${userId} in namespace ${namespace}: ${error?.message}`, error);
    return [];
  }
}

/**
 * Perform hybrid search combining vector similarity and keyword matching
 */
export async function hybridSearch(
  userId: string,
  query: string,
  queryEmbedding: number[],
  options: SearchOptions = {}
): Promise<VectorSearchResult[]> {
  // Get vector search results from user's dedicated namespace (with workspace isolation if specified)
  const vectorResults = await searchUserCodebase(userId, queryEmbedding, {
    ...options,
    limit: (options.limit || 10) * 3, // Get more results for re-ranking
    workspaceId: options.workspaceId // Pass workspaceId for namespace isolation
  });

  if (vectorResults.length === 0) {
    return [];
  }

  // Perform keyword scoring and re-ranking
  const rerankedResults = performKeywordScoring(query, vectorResults);

  // Combine scores and sort
  const finalResults = rerankedResults
    .map(result => ({
      ...result,
      // Combine vector score (0-1) and keyword score (0-1) with weights
      combinedScore: (result.score * 0.7) + (result.keywordScore * 0.3)
    }))
    .sort((a, b) => b.combinedScore - a.combinedScore)
    .slice(0, options.limit || 10);

  const userNamespace = getUserNamespace(userId);
  logger.info(`Hybrid search completed: returning ${finalResults.length} results for user ${userId} from namespace ${userNamespace}`);
  return finalResults;
}

/**
 * Perform keyword scoring on search results
 */
function performKeywordScoring(
  query: string,
  results: VectorSearchResult[]
): Array<VectorSearchResult & { keywordScore: number }> {
  const queryLower = query.toLowerCase();
  const queryTokens = tokenize(queryLower);

  return results.map(result => {
    let keywordScore = 0;
    const highlights: string[] = [];

    // Score based on exact matches in different fields
    const contentLower = result.chunk.content.toLowerCase();
    const nameLower = (result.chunk.name || '').toLowerCase();
    const filePathLower = result.chunk.filePath.toLowerCase();

    // Exact query match in content
    if (contentLower.includes(queryLower)) {
      keywordScore += 0.5;
      highlights.push(`Exact match in content`);
    }

    // Exact query match in name
    if (nameLower && nameLower.includes(queryLower)) {
      keywordScore += 0.3;
      highlights.push(`Exact match in name: ${result.chunk.name}`);
    }

    // Exact query match in file path
    if (filePathLower.includes(queryLower)) {
      keywordScore += 0.2;
      highlights.push(`Match in file path`);
    }

    // Token-based matching
    const contentTokens = tokenize(contentLower);
    const matchedTokens = queryTokens.filter(token => contentTokens.includes(token));
    const tokenMatchRatio = matchedTokens.length / queryTokens.length;
    keywordScore += tokenMatchRatio * 0.3;

    // Boost for matches at the beginning of content
    if (contentLower.startsWith(queryLower)) {
      keywordScore += 0.2;
    }

    // Boost for function/class names that match
    if (result.chunk.type === 'function' || result.chunk.type === 'class' || result.chunk.type === 'method') {
      if (nameLower && queryTokens.some(token => nameLower.includes(token))) {
        keywordScore += 0.2;
      }
    }

    // Normalize score to 0-1 range
    keywordScore = Math.min(1, keywordScore);

    return {
      ...result,
      keywordScore,
      highlights: highlights.length > 0 ? highlights : result.highlights
    };
  });
}

/**
 * Simple tokenizer for keyword matching
 */
function tokenize(text: string): string[] {
  // Split on non-alphanumeric characters and filter out empty tokens
  return text
    .split(/[^a-z0-9]+/)
    .filter(token => token.length > 2); // Ignore very short tokens
}

/**
 * Delete vectors for a specific file in user's namespace
 * @param userId The user ID
 * @param filePath The file path to delete vectors for
 * @param workspaceId Optional workspace ID to filter by
 */
export async function deleteFileVectors(
  userId: string,
  filePath: string,
  workspaceId?: string
): Promise<void> {
  await initializeIndex();

  if (!pineconeIndex) {
    throw new Error('Pinecone index not initialized');
  }

  const userNamespace = getUserNamespace(userId);

  try {
    // Query to find all vectors for this file in user's namespace
    // Build the filter with file path and optional workspace ID
    const filter: any = {
      filePath: { $eq: filePath }
    };
    
    // Add workspaceId filter if provided
    if (workspaceId) {
      filter.workspaceId = workspaceId;
    }
    
    const queryResponse = await pineconeIndex.namespace(userNamespace).query({
      vector: new Array(3072).fill(0), // Dummy vector
      topK: 10000,
      filter,
      includeValues: false
    });

    if (queryResponse.matches && queryResponse.matches.length > 0) {
      const ids = queryResponse.matches.map((match: any) => match.id);

      // Delete in batches from user's namespace
      const batchSize = 1000;
      for (let i = 0; i < ids.length; i += batchSize) {
        const batch = ids.slice(i, i + batchSize);
        await pineconeIndex.namespace(userNamespace).deleteMany(batch);
      }

      logger.info(`Deleted ${ids.length} vectors for file ${filePath} from user ${userId} namespace ${userNamespace}`);
    }
  } catch (error) {
    logger.error(`Error deleting vectors for file ${filePath} from user ${userId} namespace ${userNamespace}:`, error);
    throw error;
  }
}

/**
 * Delete all vectors for a user's workspace
 * 
 * @param userId - The user ID
 * @param workspaceId - Optional workspace ID. If provided, only vectors for this workspace will be deleted.
 *                     If not provided, all vectors for the user will be deleted (legacy behavior)
 */
/**
 * Fetch metadata for vectors by their IDs
 * Used by document indexing to check if documents exist
 */
export async function fetchMetadataByIds(namespace: string, ids: string[]): Promise<PineconeRecordMetadata[]> {
  await initializeIndex();

  if (!pineconeIndex) {
    throw new Error('Pinecone index not initialized');
  }

  try {
    if (ids.length === 0) {
      return [];
    }

    const results: PineconeRecordMetadata[] = [];
    
    // Process in batches of 100 (Pinecone limit)
    const batchSize = 100;
    for (let i = 0; i < ids.length; i += batchSize) {
      const batchIds = ids.slice(i, i + batchSize);
      
      const response = await pineconeIndex.namespace(namespace).fetch(batchIds);
      
      if (response && response.records) {
        for (const id of batchIds) {
          const vector = response.records[id];
          if (vector && vector.metadata) {
            results.push(vector.metadata as PineconeRecordMetadata);
          }
        }
      }
    }
    
    return results;
  } catch (error) {
    logger.error(`Error fetching metadata for vectors in namespace ${namespace}:`, error);
    throw error;
  }
}

/**
 * Fetch vectors by metadata filter
 * Used by document indexing to find all chunks for a document
 */
export async function fetchVectorsByMetadata(
  namespace: string,
  metadataFilter: Record<string, any>
): Promise<Array<{id: string, metadata: PineconeRecordMetadata}>> {
  await initializeIndex();

  if (!pineconeIndex) {
    throw new Error('Pinecone index not initialized');
  }

  try {
    const filterObj: Record<string, any> = {};
    
    // Convert flat filter to Pinecone filter format
    Object.entries(metadataFilter).forEach(([key, value]) => {
      filterObj[key] = { $eq: value };
    });
    
    // Use dummy vector for metadata-only query
    const queryResponse = await pineconeIndex.namespace(namespace).query({
      vector: new Array(3072).fill(0),
      topK: 10000, // Maximum allowed
      filter: Object.keys(filterObj).length > 0 ? filterObj : undefined,
      includeMetadata: true,
      includeValues: false
    });
    
    if (!queryResponse.matches) {
      return [];
    }
    
    return queryResponse.matches.map(match => ({
      id: match.id,
      metadata: match.metadata as PineconeRecordMetadata
    }));
  } catch (error) {
    logger.error(`Error fetching vectors by metadata in namespace ${namespace}:`, error);
    throw error;
  }
}

/**
 * Delete vectors by IDs
 * Used by document indexing to remove document chunks
 */
export async function deleteVectors(namespace: string, ids: string[]): Promise<void> {
  await initializeIndex();

  if (!pineconeIndex) {
    throw new Error('Pinecone index not initialized');
  }

  try {
    if (ids.length === 0) {
      return;
    }
    
    // Delete in batches of 1000 (Pinecone limit)
    const batchSize = 1000;
    for (let i = 0; i < ids.length; i += batchSize) {
      const batchIds = ids.slice(i, i + batchSize);
      await pineconeIndex.namespace(namespace).deleteMany(batchIds);
    }
    
    logger.info(`Deleted ${ids.length} vectors from namespace ${namespace}`);
  } catch (error) {
    logger.error(`Error deleting vectors from namespace ${namespace}:`, error);
    throw error;
  }
}

export async function deleteUserVectors(userId: string, workspaceId?: string): Promise<void> {
  await initializeIndex();

  if (!pineconeIndex) {
    throw new Error('Pinecone index not initialized');
  }

  // Always use the single user namespace
  const userNamespace = getUserNamespace(userId);

  try {
    if (workspaceId) {
      // If workspaceId is provided, only delete vectors for that workspace using metadata filtering
      // First query to find all vectors for this workspace
      const queryResponse = await pineconeIndex.namespace(userNamespace).query({
        vector: new Array(3072).fill(0), // Dummy vector
        topK: 10000, // Retrieve as many as possible
        filter: {
          workspaceId: { $eq: workspaceId }
        },
        includeValues: false
      });

      if (queryResponse.matches && queryResponse.matches.length > 0) {
        const ids = queryResponse.matches.map((match: any) => match.id);

        // Delete in batches
        const batchSize = 1000;
        for (let i = 0; i < ids.length; i += batchSize) {
          const batch = ids.slice(i, i + batchSize);
          await pineconeIndex.namespace(userNamespace).deleteMany(batch);
        }

        logger.info(`Successfully deleted ${ids.length} vectors for user ${userId}, workspace ${workspaceId} from namespace ${userNamespace}`);
      } else {
        logger.info(`No vectors found for user ${userId}, workspace ${workspaceId} in namespace ${userNamespace}`);
      }
    } else {
      // If no workspaceId, delete all vectors for this user (entire namespace)
      await pineconeIndex.namespace(userNamespace).deleteAll();
      logger.info(`Successfully deleted all vectors for user ${userId} from namespace ${userNamespace}`);
    }
  } catch (error: any) {
    // Check if the error is a Pinecone 404 or similar "not found" error
    if (error && (error.status === 404 || 
        (error.message && error.message.toLowerCase().includes('namespace not found')) || 
        (error.body && typeof error.body === 'string' && error.body.toLowerCase().includes('could not find namespace')))) {
      logger.info(`Attempted to delete namespace ${userNamespace} for user ${userId}, but it was not found or already empty. Considered successful.`);
    } else {
      logger.error(`Error deleting all vectors for user ${userId} from namespace ${userNamespace}:`, error);
      throw error;
    }
  }
}

/**
 * Get namespace statistics for a specific user and/or workspace
 * 
 * @param userId - The user ID
 * @param workspaceId - Optional workspace ID to get stats for a specific workspace
 * @returns The number of vectors in the namespace
 */
export async function getUserNamespaceStats(userId: string, workspaceId?: string): Promise<number> {
  await initializeIndex();

  if (!pineconeIndex) {
    return 0;
  }

  try {
    // Get the single user namespace
    const namespace = getUserNamespace(userId);
    
    if (workspaceId) {
      // If workspaceId is provided, we need to count vectors with that specific workspaceId in metadata
      // First query to count vectors for this workspace
      const queryResponse = await pineconeIndex.namespace(namespace).query({
        vector: new Array(3072).fill(0), // Dummy vector
        topK: 10000, // Maximum allowed by Pinecone
        filter: {
          workspaceId: { $eq: workspaceId }
        },
        includeValues: false
      });

      const count = queryResponse.matches?.length || 0;
      return count;
    } else {
      // If no workspaceId, get stats for the entire namespace
      const allStats = await pineconeIndex.describeIndexStats();
      const namespaceData = allStats.namespaces?.[namespace];
      return namespaceData ? namespaceData.recordCount : 0;
    }
  } catch (error: any) {
    const namespace = getUserNamespace(userId, workspaceId);
    logger.error(`Error getting full index stats (for user ${userId}, namespace ${namespace}). Error: ${error?.message || 'Unknown error'}`, error);
    throw error; 
  }
}

/**
 * Get the actual count of vectors stored for a user
 * This is useful for progress calculation and UI display
 */
export async function getUserVectorCount(userId: string, workspaceId?: string): Promise<number> {
  try {
    // getUserNamespaceStats directly returns the vector count as a number
    const vectorCount = await getUserNamespaceStats(userId, workspaceId);
    return vectorCount;
  } catch (error: any) {
    // Most errors, including non-existent namespace, are handled in getUserNamespaceStats.
    // This catch is for other potential issues during the process.
    logger.warn(`Could not get vector count for user ${userId}${workspaceId ? `, workspace ${workspaceId}` : ''} due to an error: ${(error as Error).message}`);
    return 0; // Default to 0 on any error
  }
}

/**
 * List all tenant namespaces in the index
 * Useful for admin operations and monitoring
 */
export async function listTenantNamespaces(): Promise<Array<{
  namespace: string;
  userId: string;
  vectorCount: number;
}>> {
  await initializeIndex();

  if (!pineconeIndex) {
    throw new Error('Pinecone index not initialized');
  }

  try {
    const stats = await pineconeIndex.describeIndexStats();
    const tenants: Array<{
      namespace: string;
      userId: string;
      vectorCount: number;
    }> = [];

    if (stats.namespaces) {
      for (const [namespace, namespaceStats] of Object.entries(stats.namespaces)) {
        // Extract userId from namespace (format: "user-{userId}" or "user-{userId}-{baseNamespace}")
        const userMatch = namespace.match(/^user-([^-]+)/);
        if (userMatch) {
          tenants.push({
            namespace,
            userId: userMatch[1],
            vectorCount: typeof namespaceStats === 'number' ? namespaceStats : (namespaceStats.recordCount || 0) // Handle both formats
          });
        }
      }
    }

    logger.info(`Found ${tenants.length} tenant namespaces in index`);
    return tenants;
  } catch (error) {
    logger.error('Error listing tenant namespaces:', error);
    throw error;
  }
}

/**
 * Check if a user has any vectors stored (tenant exists)
 */
export async function tenantExists(userId: string): Promise<boolean> {
  try {
    const vectorCount = await getUserNamespaceStats(userId);
    return vectorCount > 0; // Just check the number directly
  } catch (error) {
    logger.debug(`Tenant check failed for user ${userId}:`, error);
    return false;
  }
}

/**
 * Clean up inactive workspaces for a user, keeping only the active workspace
 * This is more efficient than using separate namespaces per workspace
 * 
 * @param userId - The user ID
 * @param activeWorkspaceId - The active workspace ID to keep
 * @returns Number of vectors deleted from inactive workspaces
 */
export async function cleanupInactiveWorkspaces(userId: string, activeWorkspaceId: string): Promise<number> {
  await initializeIndex();

  if (!pineconeIndex) {
    throw new Error('Pinecone index not initialized');
  }

  // Always use the single user namespace
  const userNamespace = getUserNamespace(userId);

  try {
    // First query to find all vectors with different workspaceId values
    const queryResponse = await pineconeIndex.namespace(userNamespace).query({
      vector: new Array(3072).fill(0), // Dummy vector
      topK: 10000, // Maximum allowed in a single query
      filter: {
        $and: [
          { workspaceId: { $exists: true } },
          { workspaceId: { $ne: activeWorkspaceId } }
        ]
      },
      includeValues: false
    });

    if (queryResponse.matches && queryResponse.matches.length > 0) {
      const ids = queryResponse.matches.map((match: any) => match.id);

      // Delete in batches
      const batchSize = 1000;
      let deletedCount = 0;
      
      for (let i = 0; i < ids.length; i += batchSize) {
        const batch = ids.slice(i, i + batchSize);
        await pineconeIndex.namespace(userNamespace).deleteMany(batch);
        deletedCount += batch.length;
      }
      
      logger.info(`Cleaned up ${deletedCount} vectors from inactive workspaces for user ${userId}, keeping only active workspace ${activeWorkspaceId}`);
      return deletedCount;
    } else {
      logger.info(`No inactive workspace vectors found for user ${userId}. Only active workspace ${activeWorkspaceId} exists.`);
      return 0;
    }
  } catch (error: any) {
    logger.error(`Error cleaning up inactive workspaces for user ${userId}:`, error);
    throw error;
  }
}

