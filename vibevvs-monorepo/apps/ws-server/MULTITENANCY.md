# Multitenancy Implementation with Pinecone

This document explains how we've implemented multitenancy in the Coode WebSocket server using Pinecone's namespace feature for complete data isolation between users.

## Overview

We use **Pinecone's serverless index with user-specific namespaces** to achieve true multitenancy. Each user gets their own dedicated namespace, ensuring complete data isolation and optimal performance.

## Architecture

```
Pinecone Serverless Index: "coode-codebase"
├── Namespace: "user-{userId1}"     ← User 1's vectors
├── Namespace: "user-{userId2}"     ← User 2's vectors  
├── Namespace: "user-{userId3}"     ← User 3's vectors
└── ...
```

## Benefits

✅ **Complete Data Isolation**: Each user's data is physically separated in different namespaces  
✅ **No Noisy Neighbors**: One user's operations don't affect others  
✅ **Cost Efficiency**: Queries only scan relevant user data, reducing costs  
✅ **Easy Tenant Offboarding**: Delete entire namespace with one operation  
✅ **Automatic Scaling**: Serverless architecture scales based on usage  
✅ **No Maintenance**: No compute or storage resources to manage  

## Implementation Details

### Namespace Format

- **Basic**: `user-{userId}` (e.g., `user-clerk_abc123`)
- **With Base Namespace**: `user-{userId}-{baseNamespace}` (e.g., `user-clerk_abc123-production`)

### Key Functions

#### 1. Vector Storage (`upsertVectors`)
```typescript
// Stores vectors in user's dedicated namespace
await upsertVectors(userId, vectors);
// → Stores in namespace: "user-{userId}"
```

#### 2. Vector Search (`searchUserCodebase`, `hybridSearch`)
```typescript
// Searches only within user's namespace
const results = await hybridSearch(userId, query, embedding, options);
// → Searches in namespace: "user-{userId}"
```

#### 3. File Deletion (`deleteFileVectors`)
```typescript
// Deletes file vectors from user's namespace only
await deleteFileVectors(userId, filePath);
```

#### 4. Tenant Offboarding (`deleteUserVectors`)
```typescript
// Completely removes all user data (GDPR compliance)
await deleteUserVectors(userId);
// → Deletes entire namespace: "user-{userId}"
```

### Admin Functions

#### List All Tenants
```typescript
const tenants = await listTenantNamespaces();
// Returns: [{ namespace, userId, vectorCount }, ...]
```

#### Check Tenant Existence
```typescript
const exists = await tenantExists(userId);
// Returns: boolean
```

#### Get User Statistics
```typescript
const stats = await getUserNamespaceStats(userId);
// Returns: { vectorCount, namespace, userId, ... }
```

## Migration from Shared Namespace

The previous implementation used a shared namespace with metadata filtering:
```typescript
// OLD: Shared namespace with userId filter
filter: { userId: { $eq: userId } }
```

The new implementation uses dedicated namespaces:
```typescript
// NEW: User-specific namespace
pineconeIndex.namespace(`user-${userId}`)
```

### Benefits of Migration

1. **Better Performance**: No need to filter by userId in queries
2. **True Isolation**: Physical separation of data
3. **Cost Reduction**: Queries scan fewer vectors
4. **Simplified Queries**: No complex metadata filtering needed
5. **GDPR Compliance**: Easy complete data deletion

## Configuration

Set these environment variables:

```bash
PINECONE_API_KEY=your_api_key
PINECONE_INDEX_NAME=coode-codebase
PINECONE_NAMESPACE=default  # Optional base namespace
```

## Monitoring

### Index Statistics
```typescript
const stats = await getIndexStats();
console.log(`Total namespaces: ${Object.keys(stats.namespaces).length}`);
```

### User Statistics
```typescript
const userStats = await getUserNamespaceStats(userId);
console.log(`User ${userId} has ${userStats.totalVectorCount} vectors`);
```

### All Tenants
```typescript
const tenants = await listTenantNamespaces();
console.log(`Active tenants: ${tenants.length}`);
tenants.forEach(t => console.log(`${t.userId}: ${t.vectorCount} vectors`));
```

## Security Considerations

1. **Namespace Isolation**: Each user can only access their own namespace
2. **Authentication Required**: All operations require valid userId from authenticated session
3. **No Cross-Tenant Access**: Impossible to accidentally query another user's data
4. **Audit Trail**: All operations are logged with userId and namespace

## Cost Optimization

1. **Reduced Query Costs**: Only scan relevant user data
2. **Efficient Storage**: No duplicate metadata across users
3. **Serverless Scaling**: Pay only for what you use
4. **Batch Operations**: Optimized for bulk operations

## Troubleshooting

### Common Issues

1. **Namespace Not Found**: User has no vectors yet (normal for new users)
2. **Empty Results**: User's namespace exists but no matching vectors
3. **Permission Errors**: Check API key and index configuration

### Debug Commands

```typescript
// Check if user has any data
const exists = await tenantExists(userId);

// Get detailed user stats
const stats = await getUserNamespaceStats(userId);

// List all tenants
const tenants = await listTenantNamespaces();
```

## Future Enhancements

1. **Namespace Archiving**: Move inactive users to cold storage
2. **Cross-Tenant Analytics**: Aggregate statistics across tenants
3. **Tenant Migration**: Move users between environments
4. **Backup/Restore**: Per-tenant backup capabilities

---

This multitenancy implementation follows Pinecone's best practices and provides enterprise-grade data isolation for the Coode platform. 