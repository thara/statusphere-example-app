import type { Database } from '#/db'
import * as Profile from '#/lexicon/types/app/bsky/actor/profile'
import * as Status from '#/lexicon/types/xyz/statusphere/status'
import { IdResolver, MemoryCache } from '@atproto/identity'
import { Event, Firehose } from '@atproto/sync'
import pino from 'pino'
import { env } from './env'

const HOUR = 60e3 * 60
const DAY = HOUR * 24

export function createIngester(db: Database) {
  const logger = pino({ name: 'firehose', level: env.LOG_LEVEL })
  return new Firehose({
    filterCollections: ['xyz.statusphere.status', 'app.bsky.actor.profile'],
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
          logger.debug(
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
        }
      } else if (
        evt.event === 'delete' &&
        evt.collection === 'xyz.statusphere.status'
      ) {
        logger.debug(
          { uri: evt.uri.toString(), did: evt.did },
          'deleting status',
        )

        // Remove the status from our SQLite
        await db
          .deleteFrom('status')
          .where('uri', '=', evt.uri.toString())
          .execute()
      }

      if (evt.collection === 'app.bsky.actor.profile') {
        if (evt.event === 'create' || evt.event === 'update') {
          const record = evt.record
          if (Profile.isRecord(record) && Profile.validateRecord(record).success) {
            logger.debug( { did: evt.did, displayName: record.displayName, event: evt.event }, 'ingesting profile')

            // Extract blob CIDs if present
            const avatarCid = record.avatar?.ref?.toString() || null
            const avatarMimeType = record.avatar?.mimeType || null
            const bannerCid = record.banner?.ref?.toString() || null
            const bannerMimeType = record.banner?.mimeType || null

            await db.insertInto('profile').values({
              did: evt.did,
              displayName: record.displayName || null,
              description: record.description || null,
              avatarCid,
              avatarMimeType,
              bannerCid,
              bannerMimeType,
              indexedAt: now.toISOString(),
            }).onConflict((oc) =>
              oc.column('did').doUpdateSet({
                displayName: record.displayName || null,
                description: record.description || null,
                avatarCid,
                avatarMimeType,
                bannerCid,
                bannerMimeType,
                indexedAt: now.toISOString(),
              })
            ).execute()
          }
        } else if (evt.event === 'delete') {
          logger.debug({ did: evt.did }, 'deleting profile')
          await db.deleteFrom('profile').where('did', '=', evt.did).execute()
        }
      }
    },
    onError: (err: unknown) => {
      logger.error({ err }, 'error on firehose ingestion')
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
