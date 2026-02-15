# フォローのステータス表示機能 - 実装計画

## 概要

認証済みユーザーの `app.bsky.graph.follow` フォローリストを取得し、フォローしているユーザーのステータスのみをフィルタ表示する機能を追加する。

## 設計方針

### アプローチ: DB キャッシュ + リクエスト時取得のハイブリッド

**フォロー取得方法**: `agent.com.atproto.repo.listRecords` で `app.bsky.graph.follow` コレクションからユーザーの PDS 上のフォローレコードを取得する。

**2つの選択肢と推奨**:

| 方式 | メリット | デメリット |
|------|---------|-----------|
| A: リクエスト毎にAPI取得 | 常に最新、DB変更不要 | フォロー多数時に遅い、レート制限リスク |
| B: DBキャッシュ + 定期同期 | 高速クエリ、JOINで効率的 | データの鮮度、マイグレーション必要 |
| C: B + firehoseでリアルタイム同期 | ほぼリアルタイム | 複雑、全ユーザーのfollowイベントを処理必要 |

**推奨: 方式 B** — ログイン時とホームページアクセス時（一定間隔）にフォローを同期。例示アプリとしてシンプルさと実用性のバランスが良い。

---

## 実装ステップ

### Step 1: `follow` テーブルを DB に追加

**ファイル**: `src/db.ts`

- `DatabaseSchema` に `follow` テーブル型を追加:
  ```typescript
  export type Follow = {
    uri: string         // PK: at://did/app.bsky.graph.follow/rkey
    authorDid: string   // フォローしている側の DID
    subjectDid: string  // フォローされている側の DID
    indexedAt: string    // ローカルキャッシュの更新時刻
  }
  ```
- マイグレーション `003` を追加:
  - `follow` テーブル作成 (uri PK, authorDid, subjectDid, indexedAt)
  - `authorDid` にインデックスを作成（フォロー検索の高速化）

### Step 2: フォロー取得・キャッシュユーティリティの作成

**新規ファイル**: `src/follow-cache.ts`

- `fetchAndCacheFollows(did: string, agent: Agent, db: Database, logger: Logger)` 関数:
  1. `agent.com.atproto.repo.listRecords({ repo: did, collection: 'app.bsky.graph.follow', limit: 100 })` でフォローを取得
  2. cursor ベースのページネーションで全件取得（フォロー数が多い場合に対応）
  3. 各レコードから `subject` (フォロー先DID) を抽出
  4. 既存キャッシュを削除 (`DELETE FROM follow WHERE authorDid = ?`) してから INSERT（フォロー解除の反映）
  5. バッチ INSERT で `follow` テーブルに保存
  6. エラーはログのみ（ブロッキングしない）

- `getFollowedDids(authorDid: string, db: Database): Promise<string[]>` ヘルパー:
  - DB からフォロー先 DID の一覧を返す

### Step 3: フォロー同期のタイミング

**ファイル**: `src/routes.ts`

- **ログイン時** (`/oauth/callback`): OAuthフロー完了後にバックグラウンドでフォロー同期を実行（レスポンスをブロックしない）
- **ホームページアクセス時** (`/`): 認証済みユーザーに対して、最終同期から一定時間（例: 5分）経過していたらバックグラウンドで再同期
  - `follow` テーブルの `indexedAt` の最大値で最終同期時刻を判定
  - 同期はページレンダリングをブロックしない（`void` で呼び出す、もしくは最初のアクセスのみ `await`）

### Step 4: ホームページルートの修正

**ファイル**: `src/routes.ts`

`GET /` ルートを修正:

1. クエリパラメータ `?filter=following` を受け取る
2. `filter=following` かつ認証済みの場合:
   - `getFollowedDids(agent.assertDid, db)` でフォロー先 DID 一覧を取得
   - ステータスクエリに `WHERE authorDid IN (...)` 条件を追加
   - フォロー先が 0 件の場合は空リストを表示（メッセージ付き）
3. フィルタなし or 未認証の場合: 現行と同じ（全ステータス表示）
4. テンプレートに `filter` の現在値を渡す

```typescript
const filter = req.query.filter as string | undefined

let statusQuery = ctx.db
  .selectFrom('status')
  .leftJoin('profile', 'status.authorDid', 'profile.did')
  .select([...])
  .orderBy('status.indexedAt', 'desc')
  .limit(10)

if (filter === 'following' && agent) {
  const followedDids = await getFollowedDids(agent.assertDid, ctx.db)
  if (followedDids.length > 0) {
    statusQuery = statusQuery.where('status.authorDid', 'in', followedDids)
  } else {
    // フォロー先なし → 空のステータスリスト
    statusQuery = statusQuery.where('status.authorDid', '=', '__none__')
  }
}
```

### Step 5: UI の更新

**ファイル**: `src/pages/home.ts`

- `Props` に `filter?: string` と `isLoggedIn: boolean` を追加
- ステータス一覧の上部にタブ UI を追加:

```html
<div class="feed-tabs">
  <a href="/" class="tab {filter !== 'following' ? 'active' : ''}">All</a>
  <a href="/?filter=following" class="tab {filter === 'following' ? 'active' : ''}">Following</a>
</div>
```

- タブは認証済みの場合のみ表示（未認証時は「All」のみ）
- フォロー先のステータスが 0 件の場合のメッセージ表示:
  - 「フォローしているユーザーのステータスはまだありません」

**ファイル**: `src/pages/public/styles.css`

- `.feed-tabs` のスタイル追加（タブの見た目）

---

## データフロー図

```
ログイン時:
  OAuth callback → session 保存 → fetchAndCacheFollows() (async)
                                    ↓
                          PDS listRecords(app.bsky.graph.follow)
                                    ↓
                          follow テーブルに INSERT

ホームページ表示 (?filter=following):
  GET / → getSessionAgent()
        → getFollowedDids(myDid)  // follow テーブルから取得
        → SELECT status WHERE authorDid IN (followedDids)
        → レンダリング
```

---

## 変更対象ファイル一覧

| ファイル | 変更内容 |
|---------|---------|
| `src/db.ts` | `Follow` 型追加、マイグレーション 003 追加 |
| `src/follow-cache.ts` | **新規作成**: フォロー取得・キャッシュ関数 |
| `src/routes.ts` | ログインコールバック後の同期、`/` ルートのフィルタ対応 |
| `src/pages/home.ts` | タブ UI 追加、Props 拡張 |
| `src/pages/public/styles.css` | タブスタイル追加 |

---

## 考慮事項

### パフォーマンス
- `listRecords` は 1 リクエストで最大 100 件。フォロー 1000 人なら 10 リクエスト必要
- フォロー同期はページレンダリングをブロックしない設計にする
- SQLite の `IN` 句にフォロー先 DID を渡す。数千件でも SQLite なら問題ない

### フォロー解除の反映
- 同期時に DELETE + INSERT（全置換）でフォロー解除を確実に反映
- リアルタイム性は不要（5分間隔の同期で十分）

### 将来の拡張（今回のスコープ外）
- Firehose で `app.bsky.graph.follow` を購読してリアルタイム同期
- フォロー先のプロフィールの一括キャッシュ
- ページネーション（10件以上のステータス表示）
