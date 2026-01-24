import type { Database } from '#/db'
import * as Profile from '#/lexicon/types/app/bsky/actor/profile'
import { Agent } from '@atproto/api'
import { IdResolver } from '@atproto/identity'
import pino from 'pino'

/**
 * Fetch a user's profile from their PDS and cache it in the local database.
 * This is used to ensure display names appear for statuses from other users.
 *
 * Errors are logged but not thrown - this operation should not block the caller.
 */
export async function fetchAndCacheProfile(
  did: string,
  db: Database,
  idResolver: IdResolver,
  logger: pino.Logger,
): Promise<void> {
  try {
    // Resolve the DID to get the PDS service URL
    const didDoc = await idResolver.did.resolve(did)
    if (!didDoc) {
      logger.debug({ did }, 'could not resolve DID document')
      return
    }

    // Find the PDS service endpoint
    const pdsService = didDoc.service?.find(
      (s) => s.id === '#atproto_pds' || s.type === 'AtprotoPersonalDataServer',
    )
    if (!pdsService || typeof pdsService.serviceEndpoint !== 'string') {
      logger.debug({ did }, 'no PDS service found in DID document')
      return
    }

    // Create an unauthenticated agent for the user's PDS
    const agent = new Agent({ service: pdsService.serviceEndpoint })

    // Fetch the profile record
    const profileResponse = await agent.com.atproto.repo
      .getRecord({
        repo: did,
        collection: 'app.bsky.actor.profile',
        rkey: 'self',
      })
      .catch(() => undefined)

    if (!profileResponse?.data) {
      logger.debug({ did }, 'no profile record found')
      return
    }

    const profileRecord = profileResponse.data

    if (
      !Profile.isRecord(profileRecord.value) ||
      !Profile.validateRecord(profileRecord.value).success
    ) {
      logger.debug({ did }, 'invalid profile record')
      return
    }

    const record = profileRecord.value

    // Extract blob CIDs if present
    const avatarCid = record.avatar?.ref?.toString() || null
    const avatarMimeType = record.avatar?.mimeType || null
    const bannerCid = record.banner?.ref?.toString() || null
    const bannerMimeType = record.banner?.mimeType || null

    await db
      .insertInto('profile')
      .values({
        did,
        displayName: record.displayName || null,
        description: record.description || null,
        avatarCid,
        avatarMimeType,
        bannerCid,
        bannerMimeType,
        indexedAt: new Date().toISOString(),
      })
      .onConflict((oc) =>
        oc.column('did').doUpdateSet({
          displayName: record.displayName || null,
          description: record.description || null,
          avatarCid,
          avatarMimeType,
          bannerCid,
          bannerMimeType,
          indexedAt: new Date().toISOString(),
        }),
      )
      .execute()

    logger.debug({ did, displayName: record.displayName }, 'cached profile')
  } catch (err) {
    logger.warn({ err, did }, 'failed to fetch and cache profile')
  }
}
