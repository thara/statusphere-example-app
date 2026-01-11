# Profile Display Name Implementation

## Goal
Sync profile records to display "DisplayName (@handle)" format instead of just "@handle" in the status feed.

## User Requirements
- Display format: "DisplayName (@handle)"
- Cache full profile data (displayName, description, avatar, banner)
- Display names should appear immediately when users post a status
- Proactive caching on status post

## Architecture Overview

This implementation uses a **proactive caching strategy**:

1. **Proactive Caching**: Actively fetches and caches profiles when users post a status
2. **Database Cache**: SQLite table stores profile data with LEFT JOIN to status table
3. **Graceful Fallback**: Falls back to @handle if profile not cached

This ensures display names appear immediately when users post a status.

## Implementation Steps

### 1. Add Profile Table to Database
**File:** `src/db.ts`

**Add Profile type to schema** (after line 16):
```typescript
export type Profile = {
  did: string              // Primary key
  displayName: string | null
  description: string | null
  avatarCid: string | null
  avatarMimeType: string | null
  bannerCid: string | null
  bannerMimeType: string | null
  indexedAt: string
}
```

**Update DatabaseSchema** (line 12-16):
```typescript
export type DatabaseSchema = {
  status: Status
  profile: Profile  // ADD THIS
  auth_session: AuthSession
  auth_state: AuthState
}
```

**Add migration** (after line 76):
```typescript
migrations['002'] = {
  async up(db: Kysely<unknown>) {
    await db.schema
      .createTable('profile')
      .addColumn('did', 'varchar', (col) => col.primaryKey())
      .addColumn('displayName', 'varchar')
      .addColumn('description', 'varchar')
      .addColumn('avatarCid', 'varchar')
      .addColumn('avatarMimeType', 'varchar')
      .addColumn('bannerCid', 'varchar')
      .addColumn('bannerMimeType', 'varchar')
      .addColumn('indexedAt', 'varchar', (col) => col.notNull())
      .execute()

    await db.schema
      .createIndex('profile_did_idx')
      .on('profile')
      .column('did')
      .execute()
  },
  async down(db: Kysely<unknown>) {
    await db.schema.dropTable('profile').execute()
  },
}
```

### 2. Update Routes to Query Profiles
**File:** `src/routes.ts`

**Import Profile type** (top of file):
```typescript
import type { Profile } from '#/db'
import * as Profile from '#/lexicon/types/app/bsky/actor/profile'
```

**Replace status query with JOIN** (around line 228-250):
```typescript
// Fetch statuses with their associated profiles
const statusesWithProfiles = await ctx.db
  .selectFrom('status')
  .leftJoin('profile', 'status.authorDid', 'profile.did')
  .select([
    'status.uri',
    'status.authorDid',
    'status.status',
    'status.createdAt',
    'status.indexedAt',
    'profile.displayName',
  ])
  .orderBy('status.indexedAt', 'desc')
  .limit(10)
  .execute()

const statuses = statusesWithProfiles.map(row => ({
  uri: row.uri,
  authorDid: row.authorDid,
  status: row.status,
  displayName: row.displayName || null,
  createdAt: row.createdAt,
  indexedAt: row.indexedAt,
}))
```

The `displayName` is included directly in each status object, so the template can access it via `status.displayName`.

### 3. Update Homepage Display
**File:** `src/pages/home.ts`

**Update Props type** (line 36-41):
```typescript
type Props = {
  statuses: Status[]
  didHandleMap: Record<string, string | undefined>
  profile?: { displayName?: string }
  myStatus?: Status
}
```

Note: The `Status` type now includes a `displayName` property from the JOIN query.

**Update status display** (around lines 90-113):
```typescript
${statuses.map((status, i) => {
  const handle = didHandleMap[status.authorDid] || status.authorDid
  const displayName = status?.displayName

  // Format: "DisplayName (@handle)" or "@handle" if no displayName
  const authorDisplay = displayName
    ? html`${displayName} <span class="handle">(@${handle})</span>`
    : html`@${handle}`

  const date = ts(status)
  return html`
    <div class=${i === 0 ? 'status-line no-line' : 'status-line'}>
      <div>
        <div class="status">${status.status}</div>
      </div>
      <div class="desc">
        <a class="author" href=${toBskyLink(handle)}>${authorDisplay}</a>
        ${date === TODAY
          ? `is feeling ${status.status} today`
          : `was feeling ${status.status} on ${date}`}
      </div>
    </div>
  `
})}
```

**Note on CSS:** The `.handle` class styling should be added to your CSS file if not already present:
```css
.handle {
  font-weight: normal;
  color: #666;
}
```

### 4. Cache Profile on Status Post
**File:** `src/routes.ts`

**Add profile caching logic in POST /status handler** (after optimistic status update, before redirect):

```typescript
// Fetch and cache the user's profile
// This ensures their display name appears immediately on the homepage
try {
  const profileResponse = await agent.com.atproto.repo
    .getRecord({
      repo: agent.assertDid,
      collection: 'app.bsky.actor.profile',
      rkey: 'self',
    })
    .catch(() => undefined)

  if (profileResponse?.data) {
    const profileRecord = profileResponse.data

    if (
      Profile.isRecord(profileRecord.value) &&
      Profile.validateRecord(profileRecord.value).success
    ) {
      const record = profileRecord.value

      // Extract blob CIDs if present
      const avatarCid = record.avatar?.ref?.toString() || null
      const avatarMimeType = record.avatar?.mimeType || null
      const bannerCid = record.banner?.ref?.toString() || null
      const bannerMimeType = record.banner?.mimeType || null

      await ctx.db
        .insertInto('profile')
        .values({
          did: agent.assertDid,
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

      ctx.logger.debug(
        { did: agent.assertDid, displayName: record.displayName },
        'cached profile on status post',
      )
    }
  }
} catch (err) {
  // Don't fail the status post if profile caching fails
  ctx.logger.warn(
    { err, did: agent.assertDid },
    'failed to cache profile on status post; ignoring',
  )
}
```

**Why This Works:**
- User is already authenticated with a valid agent
- `agent.com.atproto.repo.getRecord()` fetches user's own profile using rkey `'self'`
- Profile is cached immediately when user posts a status
- Error handling ensures status post succeeds even if profile fetch fails
- Complements firehose ingestion (doesn't replace it)

## Fallback Strategy
1. If profile has displayName: show "DisplayName (@handle)"
2. If profile exists but no displayName: show "@handle"
3. If profile not yet cached: show "@handle" (from didHandleMap)
4. If DID resolution fails: show raw DID

## Key Technical Details

### BlobRef Handling
- BlobRef.ref is a CID object with `.toString()` method
- Store only CID string and mimeType, not actual blob data
- Example: `record.avatar?.ref?.toString()` extracts the CID

### Migration
- Runs automatically on startup via `migrateToLatest()`
- Index on `profile.did` optimizes JOIN operations
- Migration is numbered '002' (sequential after '001')

### Proactive Caching Strategy
- **Proactive Caching**: Actively fetches and caches profiles when users post a status
- **Benefits**:
  - Display names appear immediately for active users
  - Low overhead (only fetches when user posts)
  - Simple implementation with minimal moving parts
  - No backfill needed on startup

### Data Flow

```
User posts status
  ↓
1. Write status to AT Protocol repo (agent.com.atproto.repo.putRecord)
  ↓
2. Optimistically update local SQLite status table
  ↓
3. Fetch user's profile from AT Protocol (agent.com.atproto.repo.getRecord)
  ↓
4. Cache profile in SQLite (UPSERT)
  ↓
5. Redirect to homepage
  ↓
6. Homepage JOINs statuses with profiles
  ↓
7. Display "DisplayName (@handle)" immediately
```

The Firehose continues to monitor status updates (xyz.statusphere.status), but does not currently track profile updates. Profiles are only cached when users actively post a status.

## Testing Checklist
- [x] Database migration creates profile table
- [x] Homepage shows displayName for cached profiles
- [x] Homepage shows @handle for uncached profiles
- [x] Profile cached on status post with "cached profile on status post" log
- [x] Display name appears immediately after posting status
- [x] Handle profiles with no displayName (show @handle)
- [x] Profile fetch failure doesn't break status posting

## Critical Files
1. `src/db.ts` - Profile table schema and migration
2. `src/routes.ts` - JOIN profiles with statuses, cache on status post
3. `src/pages/home.ts` - Display "DisplayName (@handle)" format

## Future Enhancements

### Possible Improvements (Not Implemented)
1. **Firehose Profile Ingestion**: Listen for `app.bsky.actor.profile` update events on the firehose to keep cached profiles in sync with network changes
2. **Backfill on Startup**: Fetch profiles for all existing DIDs in status table
3. **Background Refresh**: Periodically refresh cached profiles (e.g., daily)
4. **Profile on Login**: Cache profile when user logs in (not just on post)
5. **Stale Profile Detection**: Track last update time and refresh profiles older than N days
6. **Batch Profile Fetching**: Fetch multiple profiles in a single request for efficiency

These can be added later if needed, but the current proactive caching approach solves the immediate problem of missing display names for active users.
