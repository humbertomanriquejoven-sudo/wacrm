import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'

const h = vi.hoisted(() => ({ embedTexts: vi.fn() }))
vi.mock('./embeddings', () => ({
  embedTexts: h.embedTexts,
  toVectorLiteral: (v: number[]) => `[${v.join(',')}]`,
}))

import { retrieveKnowledge, ingestDocument } from './knowledge'

interface FakeState {
  semantic: { id: string; content: string }[]
  fts: { id: string; content: string }[]
  chunkCount: number
  rpcCalls: string[]
  inserted: Record<string, unknown>[] | null
  deletedFor: string | null
  /** Every filter passed to a delete, in call order. */
  deleteCalls: { col: string; val: unknown }[][]
  /** Order of operations, so we can assert insert happens BEFORE prune. */
  ops: string[]
}

function makeDb() {
  const state: FakeState = {
    semantic: [],
    fts: [],
    chunkCount: 5, // account has a non-empty KB by default
    rpcCalls: [],
    inserted: null,
    deletedFor: null,
    deleteCalls: [],
    ops: [],
  }
  // Models the real supabase-js builder: every filter method returns the
  // builder, and the whole chain is thenable. The previous double resolved
  // inside .eq(), so it could not express the range/or filters that the
  // write-then-prune ingest needs.
  const builder = (op: 'select' | 'delete' | 'insert') => {
    const filters: { col: string; val: unknown }[] = []
    const b: Record<string, unknown> = {}
    const push = (col: string, val: unknown) => {
      filters.push({ col, val })
      return b
    }
    b.eq = (col: string, val: unknown) => push(col, val)
    b.lt = (col: string, val: unknown) => push(col, val)
    b.gte = (col: string, val: unknown) => push(col, val)
    b.or = (filter: string) => push('__or', filter)
    b.select = () => b
    b.delete = () => b
    b.then = (
      onFulfilled: (v: unknown) => unknown,
      onRejected?: (e: unknown) => unknown
    ) => {
      if (op === 'select') {
        return Promise.resolve({ count: state.chunkCount, error: null }).then(
          onFulfilled,
          onRejected
        )
      }
      if (op === 'delete') {
        state.ops.push('delete')
        state.deleteCalls.push(filters)
        const docFilter = filters.find((f) => f.col === 'document_id')
        if (docFilter) state.deletedFor = docFilter.val as string
        return Promise.resolve({ error: null }).then(onFulfilled, onRejected)
      }
      return Promise.resolve({ error: null }).then(onFulfilled, onRejected)
    }
    return b
  }
  const db = {
    rpc: (name: string) => {
      state.rpcCalls.push(name)
      if (name === 'match_ai_knowledge_semantic')
        return Promise.resolve({ data: state.semantic, error: null })
      if (name === 'match_ai_knowledge_fts')
        return Promise.resolve({ data: state.fts, error: null })
      return Promise.resolve({ data: null, error: null })
    },
    from: () => ({
      select: () => builder('select'),
      delete: () => builder('delete'),
      insert: (rows: Record<string, unknown>[]) => {
        state.inserted = rows
        state.ops.push('insert')
        return Promise.resolve({ error: null })
      },
    }),
  }
  return { db: db as unknown as SupabaseClient, state }
}

beforeEach(() => {
  h.embedTexts.mockReset()
  h.embedTexts.mockImplementation(async (_key: string, inputs: string[]) =>
    inputs.map((_, i) => [i, i]),
  )
})

describe('retrieveKnowledge', () => {
  it('returns [] for an empty query without touching the DB', async () => {
    const { db, state } = makeDb()
    expect(await retrieveKnowledge(db, 'acct', { embeddingsApiKey: null }, '  ')).toEqual([])
    expect(state.rpcCalls).toEqual([])
  })

  it('short-circuits (no embed, no RPC) when the KB is empty', async () => {
    const { db, state } = makeDb()
    state.chunkCount = 0
    const out = await retrieveKnowledge(db, 'acct', { embeddingsApiKey: 'sk-x' }, 'q')
    expect(out).toEqual([])
    expect(h.embedTexts).not.toHaveBeenCalled()
    expect(state.rpcCalls).toEqual([])
  })

  it('uses lexical FTS only when there is no embeddings key', async () => {
    const { db, state } = makeDb()
    state.fts = [{ id: 'f1', content: 'F1' }]
    const out = await retrieveKnowledge(db, 'acct', { embeddingsApiKey: null }, 'q')
    expect(out).toEqual(['F1'])
    expect(state.rpcCalls).toEqual(['match_ai_knowledge_fts'])
    expect(h.embedTexts).not.toHaveBeenCalled()
  })

  it('uses semantic search when an embeddings key is present', async () => {
    const { db, state } = makeDb()
    state.semantic = [
      { id: 's1', content: 'S1' },
      { id: 's2', content: 'S2' },
      { id: 's3', content: 'S3' },
    ]
    const out = await retrieveKnowledge(db, 'acct', { embeddingsApiKey: 'sk-x' }, 'q', 3)
    expect(out).toEqual(['S1', 'S2', 'S3'])
    expect(h.embedTexts).toHaveBeenCalledTimes(1)
    // Enough semantic hits → no FTS top-up.
    expect(state.rpcCalls).toEqual(['match_ai_knowledge_semantic'])
  })

  it('tops up with FTS and dedupes when semantic is short', async () => {
    const { db, state } = makeDb()
    state.semantic = [
      { id: 's1', content: 'S1' },
      { id: 's2', content: 'S2' },
    ]
    state.fts = [
      { id: 's2', content: 'S2-dup' }, // dedup by id
      { id: 'f1', content: 'F1' },
    ]
    const out = await retrieveKnowledge(db, 'acct', { embeddingsApiKey: 'sk-x' }, 'q', 3)
    expect(out).toEqual(['S1', 'S2', 'F1'])
    expect(state.rpcCalls).toEqual([
      'match_ai_knowledge_semantic',
      'match_ai_knowledge_fts',
    ])
  })
})

describe('ingestDocument', () => {
  it('embeds chunks when a key is present', async () => {
    const { db, state } = makeDb()
    await ingestDocument(db, 'acct', { embeddingsApiKey: 'sk-x' }, 'doc-1', 'hello world')
    expect(h.embedTexts).toHaveBeenCalledTimes(1)
    expect(state.deletedFor).toBe('doc-1')
    expect(state.inserted).toHaveLength(1)
    expect(state.inserted![0].embedding).toBe('[0,0]') // literal from mocked embed
    expect(state.inserted![0].account_id).toBe('acct')
  })

  it('stores chunks without embeddings when there is no key', async () => {
    const { db, state } = makeDb()
    await ingestDocument(db, 'acct', { embeddingsApiKey: null }, 'doc-1', 'hello world')
    expect(h.embedTexts).not.toHaveBeenCalled()
    expect(state.inserted![0].embedding).toBeNull()
  })

  it('deletes existing chunks and inserts nothing for empty content', async () => {
    const { db, state } = makeDb()
    await ingestDocument(db, 'acct', { embeddingsApiKey: 'sk-x' }, 'doc-1', '   ')
    expect(state.deletedFor).toBe('doc-1')
    expect(state.inserted).toBeNull()
    expect(h.embedTexts).not.toHaveBeenCalled()
  })

  it('still stores lexical chunks when embedding fails, then rethrows', async () => {
    const { db, state } = makeDb()
    h.embedTexts.mockRejectedValueOnce(new Error('rate limited'))
    await expect(
      ingestDocument(db, 'acct', { embeddingsApiKey: 'sk-x' }, 'doc-1', 'hello world'),
    ).rejects.toThrow('rate limited')
    // Chunks were inserted (lexical search works) despite the embed failure…
    expect(state.inserted).toHaveLength(1)
    expect(state.inserted![0].embedding).toBeNull()
  })

  it('writes the new chunks BEFORE pruning the old ones (no zero-chunk window)', async () => {
    const { db, state } = makeDb()
    await ingestDocument(db, 'acct', { embeddingsApiKey: null }, 'doc-1', 'hello world')
    // The delete-then-insert order left the document with NO chunks if the
    // insert failed or the process restarted mid-ingest — silently
    // unretrievable content that still rendered as a normal document.
    expect(state.ops).toEqual(['insert', 'delete'])
  })

  it('embeds before writing anything, so no state is at risk during the network call', async () => {
    const { db, state } = makeDb()
    await ingestDocument(db, 'acct', { embeddingsApiKey: 'sk-x' }, 'doc-1', 'hello world')
    // embedTexts is called while `ops` is still empty.
    expect(h.embedTexts).toHaveBeenCalledTimes(1)
    expect(state.ops).toEqual(['insert', 'delete'])
  })

  it('gives new chunks a disjoint index range so they cannot collide with stale rows', async () => {
    const { db, state } = makeDb()
    await ingestDocument(db, 'acct', { embeddingsApiKey: null }, 'doc-1', 'hello world')
    const newIndex = state.inserted![0].chunk_index as number
    expect(newIndex).toBeGreaterThanOrEqual(1_000_000)
    // The prune targets everything OUTSIDE the new range, via an or() filter.
    const prune = state.deleteCalls.at(-1)!
    expect(prune.map((f) => f.col)).toContain('document_id')
    const rangeFilter = prune.find((f) => f.col === '__or')
    expect(rangeFilter?.val).toBe('chunk_index.lt.1000000,chunk_index.gte.1000001')
  })
})
