import { IdResolver, MemoryCache } from '@atproto/identity'
import { NodeOAuthClient } from '@atproto/oauth-client-node'
import { Firehose } from '@atproto/sync'
import { pino } from 'pino'

import { createOAuthClient } from '#/auth/client'
import { createDb, Database, migrateToLatest } from '#/db'
import { createIngester } from '#/ingester'
import { env } from '#/env'
import {
  BidirectionalResolver,
  createBidirectionalResolver,
} from '#/id-resolver'

const HOUR = 60e3 * 60
const DAY = HOUR * 24

/**
 * Application state passed to the router and elsewhere
 */
export type AppContext = {
  db: Database
  idResolver: IdResolver
  ingester: Firehose
  logger: pino.Logger
  oauthClient: NodeOAuthClient
  resolver: BidirectionalResolver
  destroy: () => Promise<void>
}

export async function createAppContext(): Promise<AppContext> {
  const db = createDb(env.DB_PATH)
  await migrateToLatest(db)
  const oauthClient = await createOAuthClient(db)
  const logger = pino({ name: 'server', level: env.LOG_LEVEL })
  const idResolver = new IdResolver({
    plcUrl: env.PLC_URL,
    didCache: new MemoryCache(HOUR, DAY),
  })
  const ingester = createIngester(db, idResolver, logger)
  const resolver = createBidirectionalResolver(oauthClient)

  return {
    db,
    idResolver,
    ingester,
    logger,
    oauthClient,
    resolver,

    async destroy() {
      await ingester.destroy()
      await db.destroy()
    },
  }
}
