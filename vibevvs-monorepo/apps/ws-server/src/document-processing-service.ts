/*---------------------------------------------------------------------------------------------
 *  Copyright (c) COODE AI EDITOR. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import logger from '@repo/logger';
import { config } from './config';
import * as pineconeService from './pinecone-service';
import axios from 'axios';

// Define types for the required modules

// Pinecone index for web documents - this is an INDEX, not a namespace
const DOCUMENTS_INDEX = 'web-documents-v1';

// Configuration
const CHUNK_SIZE = 1000; // Characters per chunk
const CHUNK_OVERLAP = 200; // Overlap between chunks for context preservation
const MAX_CHUNKS_PER_DOCUMENT = 50; // Limit to prevent overly large documents

// Interface for document chunk
export interface DocumentChunk {
    id: string;
    documentId: string;
    content: string;
    chunkIndex: number;
    url: string;
    title: string;
}

// Interface for indexed document
export interface IndexedDocument {
    id: string;
    title: string;
    url: string;
    chunks: number;
    timestamp: number;
}

// Progress status for document indexing
export enum IndexingStatus {
    NotStarted = 'not-started',
    Scraping = 'scraping',
    Processing = 'processing',
    Indexing = 'indexing',
    Complete = 'complete',
    Error = 'error'
}

// Progress update interface
export interface IndexingProgress {
    url: string;
    status: IndexingStatus;
    progress?: number;
    error?: string;
}

/**
 * Get document ID from URL (use URL directly as ID)
 * 
 * @param url The URL to use as document ID
 * @returns Normalized URL string to use as document ID
 */
export function getDocumentId(url: string): string {
    // Normalize URL by trimming whitespace
    const normalizedUrl = url.trim();
    
    // Use the normalized URL directly as the document ID
    // This makes it easy to look up documents by URL and simplifies the architecture
    return normalizedUrl;
}

/**
 * Check if a document is already indexed by its URL
 */
export async function isDocumentIndexed(userId: string, url: string): Promise<boolean> {
    try {
        const documentId = getDocumentId(url);
        
        // Query Pinecone for document metadata using the document index
        // Note: No namespace is needed since we're using the index's integrated embedding model
        const result = await pineconeService.fetchMetadataByIds(DOCUMENTS_INDEX, [documentId]);
        return result.length > 0;
    } catch (error) {
        logger.error('Error checking if document is indexed:', error);
        return false;
    }
}

/**
 * Scrape web content using ScraperAPI
 */
export async function scrapeWebContent(url: string, progressCallback: (progress: IndexingProgress) => void): Promise<{ content: string, title: string }> {
    try {
        // Update status to scraping
        progressCallback({
            url,
            status: IndexingStatus.Scraping
        });

        // Use ScraperAPI directly with axios based on their documentation
        const response = await axios.get('https://api.scraperapi.com/', {
            params: {
                api_key: config.scraperApiKey,
                url: url,
                render: true,
                output_format: 'markdown'
            }
        });

        // Extract markdown content from response
        const markdownContent = response.data;

        if (!markdownContent || typeof markdownContent !== 'string') {
            throw new Error('Failed to extract markdown content from URL');
        }

        // For now, we assume the title might be harder to get from pure markdown. We can refine this.
        // A simple heuristic: try to extract the first line if it looks like a heading.
        const lines = markdownContent.split('\n');
        let documentTitle = url; // Fallback to URL
        if (lines.length > 0 && lines[0].startsWith('# ')) {
            documentTitle = lines[0].substring(2).trim();
        } else if (lines.length > 0 && lines[0].trim().length > 0 && lines[0].trim().length < 100) {
             // Or if the first line is short and seems like a title
            documentTitle = lines[0].trim();
        }

        const contentToProcess = markdownContent;

        return {
            content: contentToProcess,
            title: documentTitle
        };
    } catch (error) {
        logger.error(`Error scraping web content from ${url}:`, error);
        throw new Error(`Failed to scrape content: ${(error as Error).message}`);
    }
}

/**
 * Split document content into chunks with overlap
 */
export function chunkDocumentContent(content: string, documentId: string, url: string, title: string): DocumentChunk[] {
    try {
        // Clean and normalize text
        const cleanContent = content
            .replace(/\s+/g, ' ')
            .trim();
        
        // Calculate number of chunks needed
        const contentLength = cleanContent.length;
        const effectiveChunkSize = CHUNK_SIZE - CHUNK_OVERLAP;
        let numFullChunks = Math.floor(contentLength / effectiveChunkSize);
        
        // Limit number of chunks
        numFullChunks = Math.min(numFullChunks, MAX_CHUNKS_PER_DOCUMENT);
        
        const chunks: DocumentChunk[] = [];
        
        // Generate chunks with overlap
        for (let i = 0; i < numFullChunks; i++) {
            const start = i * effectiveChunkSize;
            const end = Math.min(start + CHUNK_SIZE, contentLength);
            
            chunks.push({
                id: `${url}_chunk_${i}`,
                documentId,
                content: cleanContent.substring(start, end),
                chunkIndex: i,
                url,
                title
            });
        }
        
        // Add final chunk if needed
        if (numFullChunks === 0 || (numFullChunks * effectiveChunkSize < contentLength)) {
            const start = numFullChunks * effectiveChunkSize;
            chunks.push({
                id: `${url}_chunk_${numFullChunks}`,
                documentId,
                content: cleanContent.substring(start),
                chunkIndex: numFullChunks,
                url,
                title
            });
        }
        
        return chunks;
    } catch (error) {
        logger.error('Error chunking document content:', error);
        throw new Error(`Failed to process document content: ${(error as Error).message}`);
    }
}

/**
 * Store document chunks in Pinecone
 */
export async function storeDocumentChunks(
    userId: string,
    chunks: Array<DocumentChunk>,
    progressCallback: (progress: IndexingProgress) => void
): Promise<void> {
    try {
        if (chunks.length === 0) {
            throw new Error('No chunks to store');
        }
        
        const url = chunks[0].url;
        
        // Update status to indexing
        progressCallback({
            url,
            status: IndexingStatus.Indexing
        });
        
        // Prepare records for Pinecone with integrated embedding model
        // Pinecone will generate embeddings using its integrated model from the 'chunk_text' field.
        // This field name must match the 'field_map' configuration of the 'web-documents-v1' index.
        const records = chunks.map(chunk => ({
            id: `${chunk.url}_chunk_${chunk.chunkIndex}`,
            metadata: {
                documentId: chunk.documentId, // This is now the URL itself
                chunkIndex: chunk.chunkIndex,
                url: chunk.url, // Include full URL in metadata for easy filtering
                title: chunk.title,
                // Keep a truncated version of content in metadata for quick previews if needed
                original_content_preview: chunk.content.substring(0, 200),
                timestamp: new Date().toISOString() // Add timestamp for version tracking
            },
            // This field contains the raw text for Pinecone to embed.
            // The name 'chunk_text' is based on the user-provided example and common Pinecone practice.
            chunk_text: chunk.content
        }));
        
        // Upsert records to Pinecone index
        await pineconeService.upsertTextRecords(DOCUMENTS_INDEX, records);
        
        // Update progress to complete
        progressCallback({
            url,
            status: IndexingStatus.Complete
        });
    } catch (error) {
        logger.error('Error storing document chunks:', error);
        throw new Error(`Failed to store document: ${(error as Error).message}`);
    }
}

/**
 * Main function to index a document
 */
export async function indexDocument(
    userId: string,
    url: string,
    progressCallback: (progress: IndexingProgress) => void
): Promise<IndexedDocument> {
    try {
        // Validate URL
        try {
            new URL(url);
        } catch (error) {
            throw new Error('Invalid URL');
        }
        
        // Get document ID (using URL directly)
        const documentId = getDocumentId(url);
        
        // Check if document already exists
        const isExisting = await isDocumentIndexed(userId, url);
        if (isExisting) {
            throw new Error('Document is already indexed');
        }
        
        // Scrape web content
        const { content, title } = await scrapeWebContent(url, progressCallback);
        
        // Split content into chunks
        const chunks = chunkDocumentContent(content, documentId, url, title);
        
        // Store chunks directly in Pinecone (it will use integrated embedding model)
        await storeDocumentChunks(userId, chunks, progressCallback);
        
        // Return indexed document info
        const indexedDocument: IndexedDocument = {
            id: documentId,
            title,
            url,
            chunks: chunks.length,
            timestamp: Date.now()
        };
        
        return indexedDocument;
    } catch (error) {
        logger.error(`Error indexing document ${url}:`, error);
        
        // Update progress with error
        progressCallback({
            url,
            status: IndexingStatus.Error,
            error: (error as Error).message
        });
        
        throw error;
    }
}

/**
 * Remove an indexed document
 */
export async function removeDocument(userId: string, documentId: string): Promise<void> {
    try {
        // In a shared namespace model, actual deletion from Pinecone is complex (requires ref counting).
        // This function will now primarily serve to acknowledge the user's intent to "remove" the document from their perspective.
        // The client-side will handle removing it from the user's list.
        // True orphan document cleanup in Pinecone would be a separate process.
        logger.info(`User ${userId} requested removal of document ${documentId}. In a shared model, Pinecone data is not immediately deleted.`);
        // If we had a user-document link table, we'd remove the link here.
        // For now, this function effectively becomes a no-op for Pinecone data modification.
    } catch (error) {
        logger.error(`Error removing document ${documentId}:`, error);
        throw error;
    }
}

/**
 * Get all indexed documents for a user
 */
export async function getIndexedDocuments(userId: string): Promise<IndexedDocument[]> {
    try {
        // With a global DOCUMENT_NAMESPACE, listing documents specifically "indexed by" a user 
        // requires a separate mechanism to track user-document associations (e.g., a database table 
        // linking userId to global documentIds, or client-side storage of documentIds).
        // This function, in its current form, cannot fulfill that from a global Pinecone namespace directly.
        logger.warn(`getIndexedDocuments for user ${userId} was called. This function needs a redesign to work with the global document namespace and user-specific views. Returning empty array.`);
        
        // To demonstrate fetching all documents from the global namespace (not user-specific):
        // const allVectors = await pineconeService.fetchVectorsByMetadata(DOCUMENT_NAMESPACE, {});
        // // ... then process allVectors to group by documentId and create IndexedDocument objects ...
        // logger.info(`Fetched ${allVectors.length} vectors from the global namespace.`);

        return []; // Placeholder: User-specific document list needs a different architecture now.
    } catch (error) {
        logger.error(`Error in getIndexedDocuments for user ${userId} (needs redesign):`, error);
        // Do not re-throw the error for now, as the function's contract is to return an array.
        // throw error; 
        return [];
    }
}
