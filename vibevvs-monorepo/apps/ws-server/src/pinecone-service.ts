import { Pinecone, Index, IndexStatsDescription } from '@pinecone-database/pinecone';
import logger from '@repo/logger';
import { config } from './config';
import { CodeChunk } from '@repo/types';

// Define a base metadata type that Pinecone's Index type expects
export type PineconeRecordMetadata = Record<string, string | number | boolean | string[]>;

// Initialize Pinecone client
let pineconeClient: Pinecone | null = null;
let pineconeIndex: Index<PineconeRecordMetadata> | null = null;
let initializationPromise: Promise<void> | null = null;

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
 * Generate user-specific namespace for multitenancy
 * Format: "user-{userId}" or "user-{userId}-{baseNamespace}" if base namespace is provided
 */
function getUserNamespace(userId: string): string {
  // Use user-specific namespace for true multitenancy
  const baseNamespace = config.pineconeNamespace;
  if (baseNamespace && baseNamespace !== 'default') {
    return `user-${userId}-${baseNamespace}`;
  }
  return `user-${userId}`;
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
  filters?: {
    fileTypes?: string[];
    paths?: string[];
    languages?: string[];
  };
}

/**
 * Upsert vectors to Pinecone using user-specific namespace for multitenancy
 */
export async function upsertVectors(
  userId: string,
  vectors: Array<{
    id: string;
    values: number[];
    metadata: Record<string, any>;
  }>
): Promise<void> {
  await initializeIndex();

  if (!pineconeIndex) {
    throw new Error('Pinecone index not initialized');
  }

  try {
    // Get user-specific namespace for multitenancy
    const userNamespace = getUserNamespace(userId);

    // Remove userId from metadata since namespace provides isolation
    const vectorsForNamespace = vectors.map(v => ({
      ...v,
      metadata: {
        ...v.metadata,
        // Keep userId in metadata for backwards compatibility and debugging
        userId,
        // Add tenant info for additional context
        tenant: userNamespace
      }
    }));

    // Upsert in batches of 100 to user's dedicated namespace
    const batchSize = 100;
    for (let i = 0; i < vectorsForNamespace.length; i += batchSize) {
      const batch = vectorsForNamespace.slice(i, i + batchSize);
      await pineconeIndex.namespace(userNamespace).upsert(batch);
      logger.debug(`Upserted batch ${Math.floor(i / batchSize) + 1}/${Math.ceil(vectorsForNamespace.length / batchSize)} to namespace ${userNamespace}`);

      // ---- START IMMEDIATE FETCH DEBUG ----
      if (batch.length > 0) {
        const firstIdInBatch = batch[0].id;
        logger.debug(`Attempting immediate fetch for ID ${firstIdInBatch} from namespace ${userNamespace} post-upsert.`);
        try {
          const fetchResult = await pineconeIndex.namespace(userNamespace).fetch([firstIdInBatch]);
          if (fetchResult && fetchResult.records && Object.keys(fetchResult.records).length > 0) {
            logger.info(`IMMEDIATE FETCH SUCCEEDED for ID ${firstIdInBatch} in namespace ${userNamespace}. Vector found.`);
          } else {
            logger.warn(`IMMEDIATE FETCH FAILED or EMPTY for ID ${firstIdInBatch} in namespace ${userNamespace}. Vector not found immediately.`);
          }
        } catch (fetchError: any) {
          logger.error(`IMMEDIATE FETCH ERROR for ID ${firstIdInBatch} in namespace ${userNamespace}: ${fetchError.message}`);
        }
      }
      // ---- END IMMEDIATE FETCH DEBUG ----
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
    // Build filter for additional filtering within the user's namespace
    const filter: any = {};

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
    const queryResponse = await pineconeIndex.namespace(userNamespace).query({
      vector: queryEmbedding,
      topK: limit * 2, // Get more results for hybrid search
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

    logger.info(`Vector search completed: found ${vectorResults.length} results for user ${userId} in namespace ${userNamespace}`);
    return vectorResults;

  } catch (error) {
    logger.error(`Error performing vector search for user ${userId} in namespace ${userNamespace}:`, error);
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
  // Get vector search results from user's dedicated namespace
  const vectorResults = await searchUserCodebase(userId, queryEmbedding, {
    ...options,
    limit: (options.limit || 10) * 3 // Get more results for re-ranking
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
 */
export async function deleteFileVectors(
  userId: string,
  filePath: string
): Promise<void> {
  await initializeIndex();

  if (!pineconeIndex) {
    throw new Error('Pinecone index not initialized');
  }

  const userNamespace = getUserNamespace(userId);

  try {
    // Query to find all vectors for this file in user's namespace
    const queryResponse = await pineconeIndex.namespace(userNamespace).query({
      vector: new Array(3072).fill(0), // Dummy vector
      topK: 10000,
      filter: {
        filePath: { $eq: filePath }
      },
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
 * Delete all vectors for a user (tenant offboarding)
 */
export async function deleteUserVectors(userId: string): Promise<void> {
  await initializeIndex();

  if (!pineconeIndex) {
    throw new Error('Pinecone index not initialized');
  }

  const userNamespace = getUserNamespace(userId);

  try {
    // Delete all vectors in the user's namespace (tenant offboarding)
    await pineconeIndex.namespace(userNamespace).deleteAll();
    logger.info(`Successfully deleted all vectors for user ${userId} from namespace ${userNamespace} (tenant offboarded)`);
  } catch (error: any) {
    // Check if the error is a Pinecone 404 or similar "not found" error
    // This is a common scenario if the namespace didn't exist or was already empty.
    // Pinecone specific error checking might be needed here depending on their SDK.
    // For now, we check for a message that implies not found or a status code if available.
    // Example: error.status === 404 or error.message.includes('not found')
    if (error && (error.status === 404 || (error.message && error.message.toLowerCase().includes('namespace not found')) || (error.body && typeof error.body === 'string' && error.body.toLowerCase().includes('could not find namespace')))) {
      logger.info(`Attempted to delete namespace ${userNamespace} for user ${userId}, but it was not found or already empty. Considered successful.`);
    } else {
      logger.error(`Error deleting all vectors for user ${userId} from namespace ${userNamespace}:`, error);
      throw error;
    }
  }
}

/**
 * Get index statistics
 */
export async function getIndexStats(): Promise<any> {
  await initializeIndex();

  if (!pineconeIndex) {
    throw new Error('Pinecone index not initialized');
  }

  try {
    const stats = await pineconeIndex.describeIndexStats();
    return stats;
  } catch (error) {
    logger.error('Error getting index stats:', error);
    throw error;
  }
}

/**
 * Get user-specific namespace statistics
 */
export async function getUserNamespaceStats(userId: string): Promise<{
  namespace: string;
  userId: string;
  recordCount?: number; // Changed from 'any' to a more specific type
}> {
  await initializeIndex();

  if (!pineconeIndex) {
    logger.error('Pinecone index not initialized, cannot get namespace stats for user ${userId}.');
    throw new Error('Pinecone index not initialized');
  }

  const userNamespace = getUserNamespace(userId);

  try {
    // Revert to using describeIndexStats() and extract the specific namespace data
    const allStats: IndexStatsDescription = await pineconeIndex.describeIndexStats();
    const namespaceData = allStats.namespaces && allStats.namespaces[userNamespace];
    const recordCount = namespaceData ? namespaceData.recordCount : 0;

    logger.info(`Namespace stats for ${userNamespace} (user: ${userId}): ${recordCount} records. Full stats: ${JSON.stringify(allStats.namespaces)}`);
    
    return {
      namespace: userNamespace,
      userId,
      recordCount: recordCount || 0 
    };
  } catch (error: any) {
    // This catch block might now be less relevant if describeIndexStats itself doesn't throw for missing namespaces often
    logger.error(`Error getting full index stats (for user ${userId}, namespace ${userNamespace}). Error: ${error.message}`, error);
    throw error; 
  }
}

/**
 * Get the actual count of vectors stored for a user
 * This is useful for progress calculation and UI display
 */
export async function getUserVectorCount(userId: string): Promise<number> {
  try {
    const stats = await getUserNamespaceStats(userId);
    // Ensure we handle cases where recordCount might be undefined or null, defaulting to 0
    return Number(stats.recordCount) || 0;
  } catch (error) {
    // Most errors, including non-existent namespace, are handled in getUserNamespaceStats.
    // This catch is for other potential issues during the process.
    logger.warn(`Could not get vector count for user ${userId} due to an error: ${(error as Error).message}`);
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
            vectorCount: namespaceStats.recordCount || 0 // Use recordCount from IndexNamespaceStats
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
    const stats = await getUserNamespaceStats(userId);
    return (stats.recordCount || 0) > 0; // Check recordCount here
  } catch (error) {
    logger.debug(`Tenant check failed for user ${userId}:`, error);
    return false;
  }
}

