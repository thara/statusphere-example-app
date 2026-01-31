import type { Database } from '#/db'
import { fetchAndCacheProfile } from '#/profile-cache'
import * as Status from '#/lexicon/types/xyz/statusphere/status'
import { IdResolver, MemoryCache } from '@atproto/identity'
import { Event, Firehose } from '@atproto/sync'
import pino from 'pino'
import { env } from './env'

const HOUR = 60e3 * 60
const DAY = HOUR * 24

export function createIngester(
  db: Database,
  idResolver: IdResolver,
  logger: pino.Logger,
) {
  const firehoseLogger = logger.child({ name: 'firehose' })
  return new Firehose({
    filterCollections: ['xyz.statusphere.status'],
    handleEvent: async (evt: Event) => {
      const now = new Date()
      // Watch for write events
      if (evt.event === 'create' || evt.event === 'update') {
        const record = evt.record

        // If the write is a valid status update
        if (
          evt.collection === 'xyz.statusphere.status' &&
          Status.isRecord(record) &&
          Status.validateRecord(record).success
        ) {
          firehoseLogger.debug(
            { uri: evt.uri.toString(), status: record.status },
            'ingesting status',
          )

          // Store the status in our SQLite
          await db
            .insertInto('status')
            .values({
              uri: evt.uri.toString(),
              authorDid: evt.did,
              status: record.status,
              createdAt: record.createdAt,
              indexedAt: now.toISOString(),
            })
            .onConflict((oc) =>
              oc.column('uri').doUpdateSet({
                status: record.status,
                indexedAt: now.toISOString(),
              }),
            )
            .execute()

          // Check if we have the author's profile cached
          const profile = await db
            .selectFrom('profile')
            .where('did', '=', evt.did)
            .selectAll()
            .executeTakeFirst()

          if (!profile) {
            // Fetch and cache profile asynchronously (don't block firehose processing)
            fetchAndCacheProfile(evt.did, db, idResolver, firehoseLogger).catch(
              () => {},
            )
          }
        }
      } else if (
        evt.event === 'delete' &&
        evt.collection === 'xyz.statusphere.status'
      ) {
        firehoseLogger.debug(
          { uri: evt.uri.toString(), did: evt.did },
          'deleting status',
        )

        // Remove the status from our SQLite
        await db
          .deleteFrom('status')
          .where('uri', '=', evt.uri.toString())
          .execute()
      }
    },
    onError: (err: unknown) => {
      firehoseLogger.error({ err }, 'error on firehose ingestion')
    },
    excludeIdentity: true,
    excludeAccount: true,
    service: env.FIREHOSE_URL,
    idResolver: new IdResolver({
      plcUrl: env.PLC_URL,
      didCache: new MemoryCache(HOUR, DAY),
    }),
  })
}
