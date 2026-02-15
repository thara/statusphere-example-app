import SqliteDb from 'better-sqlite3'
import {
  Kysely,
  Migrator,
  SqliteDialect,
  Migration,
  MigrationProvider,
} from 'kysely'

// Types

export type DatabaseSchema = {
  status: Status
  profile: Profile
  follow: Follow
  auth_session: AuthSession
  auth_state: AuthState
}

export type Status = {
  uri: string
  authorDid: string
  status: string
  createdAt: string
  indexedAt: string
}

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

export type Follow = {
  uri: string
  authorDid: string
  subjectDid: string
  indexedAt: string
}

export type AuthSession = {
  key: string
  session: AuthSessionJson
}

export type AuthState = {
  key: string
  state: AuthStateJson
}

type AuthStateJson = string

type AuthSessionJson = string

// Migrations

const migrations: Record<string, Migration> = {}

const migrationProvider: MigrationProvider = {
  async getMigrations() {
    return migrations
  },
}

migrations['001'] = {
  async up(db: Kysely<unknown>) {
    await db.schema
      .createTable('status')
      .addColumn('uri', 'varchar', (col) => col.primaryKey())
      .addColumn('authorDid', 'varchar', (col) => col.notNull())
      .addColumn('status', 'varchar', (col) => col.notNull())
      .addColumn('createdAt', 'varchar', (col) => col.notNull())
      .addColumn('indexedAt', 'varchar', (col) => col.notNull())
      .execute()
    await db.schema
      .createTable('auth_session')
      .addColumn('key', 'varchar', (col) => col.primaryKey())
      .addColumn('session', 'varchar', (col) => col.notNull())
      .execute()
    await db.schema
      .createTable('auth_state')
      .addColumn('key', 'varchar', (col) => col.primaryKey())
      .addColumn('state', 'varchar', (col) => col.notNull())
      .execute()
  },
  async down(db: Kysely<unknown>) {
    await db.schema.dropTable('auth_state').execute()
    await db.schema.dropTable('auth_session').execute()
    await db.schema.dropTable('status').execute()
  },
}

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

migrations['003'] = {
  async up(db: Kysely<unknown>) {
    await db.schema
      .createTable('follow')
      .addColumn('uri', 'varchar', (col) => col.primaryKey())
      .addColumn('authorDid', 'varchar', (col) => col.notNull())
      .addColumn('subjectDid', 'varchar', (col) => col.notNull())
      .addColumn('indexedAt', 'varchar', (col) => col.notNull())
      .execute()
    await db.schema
      .createIndex('follow_authorDid_idx')
      .on('follow')
      .column('authorDid')
      .execute()
  },
  async down(db: Kysely<unknown>) {
    await db.schema.dropTable('follow').execute()
  },
}

// APIs

export const createDb = (location: string): Database => {
  return new Kysely<DatabaseSchema>({
    dialect: new SqliteDialect({
      database: new SqliteDb(location),
    }),
  })
}

export const migrateToLatest = async (db: Database) => {
  const migrator = new Migrator({ db, provider: migrationProvider })
  const { error } = await migrator.migrateToLatest()
  if (error) throw error
}

export type Database = Kysely<DatabaseSchema>
