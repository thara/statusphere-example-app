import type { Agent } from '@atproto/api'
import type { Logger } from 'pino'

import type { Database } from '#/db'

const SYNC_INTERVAL_MS = 5 * 60 * 1000 // 5 minutes

/**
 * Fetches all follows for the given DID from their PDS and caches them
 * in the local database. Replaces all existing cached follows for the user.
 */
export async function fetchAndCacheFollows(
  did: string,
  agent: Agent,
  db: Database,
  logger: Logger,
): Promise<void> {
  try {
    const follows: { uri: string; subjectDid: string }[] = []
    let cursor: string | undefined

    // Paginate through all follow records
    do {
      const res = await agent.com.atproto.repo.listRecords({
        repo: did,
        collection: 'app.bsky.graph.follow',
        limit: 100,
        cursor,
      })

      for (const record of res.data.records) {
        const value = record.value as { subject?: string }
        if (value.subject) {
          follows.push({ uri: record.uri, subjectDid: value.subject })
        }
      }

      cursor = res.data.cursor
    } while (cursor)

    const now = new Date().toISOString()

    // Replace all cached follows for this user in a transaction
    await db.transaction().execute(async (tx) => {
      await tx.deleteFrom('follow').where('authorDid', '=', did).execute()

      if (follows.length > 0) {
        // Insert in batches to avoid SQLite variable limits
        const batchSize = 500
        for (let i = 0; i < follows.length; i += batchSize) {
          const batch = follows.slice(i, i + batchSize)
          await tx
            .insertInto('follow')
            .values(
              batch.map((f) => ({
                uri: f.uri,
                authorDid: did,
                subjectDid: f.subjectDid,
                indexedAt: now,
              })),
            )
            .execute()
        }
      }
    })

    logger.info({ did, count: follows.length }, 'cached follows')
  } catch (err) {
    logger.warn({ err, did }, 'failed to fetch and cache follows')
  }
}

/**
 * Returns the DIDs of all accounts that the given user follows.
 */
export async function getFollowedDids(
  authorDid: string,
  db: Database,
): Promise<string[]> {
  const rows = await db
    .selectFrom('follow')
    .select('subjectDid')
    .where('authorDid', '=', authorDid)
    .execute()
  return rows.map((r) => r.subjectDid)
}

/**
 * Checks whether the follow cache for the given user is stale
 * (older than the sync interval) and needs to be refreshed.
 */
export async function isFollowCacheStale(
  authorDid: string,
  db: Database,
): Promise<boolean> {
  const row = await db
    .selectFrom('follow')
    .select('indexedAt')
    .where('authorDid', '=', authorDid)
    .orderBy('indexedAt', 'desc')
    .limit(1)
    .executeTakeFirst()

  if (!row) return true

  const lastSync = new Date(row.indexedAt).getTime()
  return Date.now() - lastSync > SYNC_INTERVAL_MS
}
