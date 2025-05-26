import { Pinecone } from '@pinecone-database/pinecone';
import logger from '@repo/logger';
import { config } from './config';
import { CodeChunk } from '@repo/types';

// Initialize Pinecone client
let pineconeClient: Pinecone | null = null;
let pineconeIndex: any = null;

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

// Initialize index connection
async function initializeIndex(): Promise<void> {
  if (!pineconeClient || pineconeIndex) return;
  
  try {
    // Check if index exists, if not create it
    const indexes = await pineconeClient.listIndexes();
    const indexExists = indexes.indexes?.some(idx => idx.name === config.pineconeIndexName);
    
    if (!indexExists) {
      logger.info(`Creating Pinecone index: ${config.pineconeIndexName}`);
      await pineconeClient.createIndex({
        name: config.pineconeIndexName,
        dimension: 768, // Gemini text-embedding-004 dimension
        metric: 'cosine',
        spec: {
          serverless: {
            cloud: 'aws',
            region: 'us-east-1'
          }
        }
      });
      
      // Wait for index to be ready
      await new Promise(resolve => setTimeout(resolve, 10000));
    }
    
    pineconeIndex = pineconeClient.index(config.pineconeIndexName);
    logger.info(`Connected to Pinecone index: ${config.pineconeIndexName}`);
  } catch (error) {
    logger.error('Failed to initialize Pinecone index:', error);
    throw error;
  }
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
 * Upsert vectors to Pinecone
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
    // Add userId to metadata for each vector
    const vectorsWithUserId = vectors.map(v => ({
      ...v,
      metadata: {
        ...v.metadata,
        userId
      }
    }));
    
    // Upsert in batches of 100
    const batchSize = 100;
    for (let i = 0; i < vectorsWithUserId.length; i += batchSize) {
      const batch = vectorsWithUserId.slice(i, i + batchSize);
      await pineconeIndex.namespace(config.pineconeNamespace).upsert(batch);
      logger.debug(`Upserted batch ${Math.floor(i / batchSize) + 1}/${Math.ceil(vectorsWithUserId.length / batchSize)} to Pinecone`);
    }
    
    logger.info(`Successfully upserted ${vectors.length} vectors for user ${userId}`);
  } catch (error) {
    logger.error(`Error upserting vectors to Pinecone:`, error);
    throw error;
  }
}

/**
 * Search user's codebase using vector similarity
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
  
  try {
    // Build filter
    const filter: any = {
      userId: { $eq: userId }
    };
    
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
    
    // Query Pinecone
    const queryResponse = await pineconeIndex.namespace(config.pineconeNamespace).query({
      vector: queryEmbedding,
      topK: limit * 2, // Get more results for hybrid search
      filter,
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
            metadata: match.metadata.metadata || {}
          };
          
          vectorResults.push({
            chunk,
            score: match.score || 0,
            highlights: []
          });
        }
      }
    }
    
    logger.info(`Vector search completed: found ${vectorResults.length} results for user ${userId}`);
    return vectorResults;
    
  } catch (error) {
    logger.error(`Error performing vector search for user ${userId}:`, error);
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
  // Get vector search results
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
  
  logger.info(`Hybrid search completed: returning ${finalResults.length} results for user ${userId}`);
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
 * Delete vectors for a specific file
 */
export async function deleteFileVectors(
  userId: string,
  filePath: string
): Promise<void> {
  await initializeIndex();
  
  if (!pineconeIndex) {
    throw new Error('Pinecone index not initialized');
  }
  
  try {
    // Query to find all vectors for this file
    const queryResponse = await pineconeIndex.namespace(config.pineconeNamespace).query({
      vector: new Array(768).fill(0), // Dummy vector
      topK: 10000,
      filter: {
        userId: { $eq: userId },
        filePath: { $eq: filePath }
      },
      includeValues: false
    });
    
    if (queryResponse.matches && queryResponse.matches.length > 0) {
      const ids = queryResponse.matches.map((match: any) => match.id);
      
      // Delete in batches
      const batchSize = 1000;
      for (let i = 0; i < ids.length; i += batchSize) {
        const batch = ids.slice(i, i + batchSize);
        await pineconeIndex.namespace(config.pineconeNamespace).deleteMany(batch);
      }
      
      logger.info(`Deleted ${ids.length} vectors for file ${filePath}`);
    }
  } catch (error) {
    logger.error(`Error deleting vectors for file ${filePath}:`, error);
    throw error;
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

// Alias for backward compatibility
const searchVectors = searchUserCodebase;
const deleteUserVectors = async (userId: string) => {
  // TODO: Implement full user deletion if needed
  logger.warn('deleteUserVectors not fully implemented');
}; 