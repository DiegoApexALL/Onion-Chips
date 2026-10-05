import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { supabaseKey, supabaseUrl } from './config'
import { DEFAULT_SETTINGS, type Ingredient, type Recipe, type Settings } from './types'

export const supabase: SupabaseClient | null = supabaseUrl && supabaseKey ? createClient(supabaseUrl, supabaseKey) : null

type Table = 'ingredients' | 'recipes'
type Row<T extends Table> = T extends 'ingredients' ? Ingredient : Recipe

export interface Store {
  list<T extends Table>(table: T): Promise<Row<T>[]>
  save<T extends Table>(table: T, row: Omit<Row<T>, 'id'> & { id?: string }): Promise<Row<T>>
  remove(table: Table, id: string): Promise<void>
  /** Substitui todos os registros da tabela (usado ao restaurar um backup). */
  replaceAll<T extends Table>(table: T, rows: Row<T>[]): Promise<void>
  getSettings(): Promise<Settings>
  saveSettings(settings: Settings): Promise<void>
}

function toSettings(raw: Record<string, unknown> | null | undefined): Settings {
  const min = Number(raw?.cmv_min)
  const max = Number(raw?.cmv_max)
  return Number.isFinite(min) && Number.isFinite(max) && raw ? { cmv_min: min, cmv_max: max } : { ...DEFAULT_SETTINGS }
}

const NUMERIC = ['package_price', 'package_qty', 'yield_qty', 'extra_costs', 'margin_pct', 'sale_price']
function normalize<T>(row: Record<string, unknown>): T {
  const out: Record<string, unknown> = { ...row }
  for (const k of NUMERIC) if (out[k] != null) out[k] = Number(out[k])
  return out as T
}

const supabaseStore = (sb: SupabaseClient): Store => ({
  async list(table) {
    const { data, error } = await sb.from(table).select('*').order('name')
    if (error) throw error
    return (data ?? []).map((r) => normalize(r))
  },
  async save(table, row) {
    const { id, ...rest } = row as { id?: string }
    const q = id ? sb.from(table).update(rest).eq('id', id) : sb.from(table).insert(rest)
    const { data, error } = await q.select().single()
    if (error) throw error
    return normalize(data)
  },
  async remove(table, id) {
    const { error } = await sb.from(table).delete().eq('id', id)
    if (error) throw error
  },
  async replaceAll(table, rows) {
    const del = await sb.from(table).delete().not('id', 'is', null)
    if (del.error) throw del.error
    if (!rows.length) return
    const { error } = await sb.from(table).insert(rows)
    if (error) throw error
  },
  async getSettings() {
    const { data, error } = await sb.from('settings').select('cmv_min, cmv_max').eq('id', 1).maybeSingle()
    if (error) throw error
    return toSettings(data)
  },
  async saveSettings(settings) {
    const { error } = await sb.from('settings').upsert({ id: 1, ...settings })
    if (error) throw error
  },
})

// Modo local (sem Supabase configurado): salva no navegador
const memory = new Map<string, string>()
function read(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return memory.get(key) ?? null
  }
}
function write(key: string, value: string) {
  memory.set(key, value)
  try {
    localStorage.setItem(key, value)
  } catch {
    /* armazenamento bloqueado: fica só na memória */
  }
}

const localStore: Store = {
  async list(table) {
    try {
      const rows = JSON.parse(read(`onion-cost:${table}`) || '[]')
      return rows.sort((a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name))
    } catch {
      return []
    }
  },
  async save(table, row) {
    const rows = (await localStore.list(table)) as { id: string }[]
    const saved = { ...row, id: row.id ?? crypto.randomUUID() }
    const i = rows.findIndex((r) => r.id === saved.id)
    if (i >= 0) rows[i] = saved
    else rows.push(saved)
    write(`onion-cost:${table}`, JSON.stringify(rows))
    return saved as never
  },
  async remove(table, id) {
    const rows = (await localStore.list(table)) as { id: string }[]
    write(`onion-cost:${table}`, JSON.stringify(rows.filter((r) => r.id !== id)))
  },
  async replaceAll(table, rows) {
    write(`onion-cost:${table}`, JSON.stringify(rows))
  },
  async getSettings() {
    try {
      return toSettings(JSON.parse(read('onion-cost:settings') || 'null'))
    } catch {
      return { ...DEFAULT_SETTINGS }
    }
  },
  async saveSettings(settings) {
    write('onion-cost:settings', JSON.stringify(settings))
  },
}

/** Banco na nuvem da página publicada no Claude (dados privados de cada pessoa). */
interface ClaudeDoc {
  get(): Promise<{ exists: boolean; data(): Record<string, unknown> | undefined }>
  set(data: Record<string, unknown>): Promise<void>
}
interface ClaudeRuntime {
  use(name: 'db'): Promise<{ doc(path: string): ClaudeDoc } | null>
  use(name: 'user'): Promise<{ id(): Promise<string | null> } | null>
}

async function claudeStore(): Promise<Store | null> {
  const claude = (window as unknown as { claude?: ClaudeRuntime }).claude
  if (!claude?.use) return null
  const [db, user] = await Promise.all([claude.use('db'), claude.use('user')])
  const uid = await user?.id()
  if (!db || !uid) return null
  const ref = (table: Table | 'settings') => db.doc(`data/users/${uid}/${table}`)
  const read = async (table: Table) => {
    const snap = await ref(table).get()
    return ((snap.exists && (snap.data()?.rows as { id: string; name: string }[])) || []).slice()
  }
  const write = (table: Table | 'settings', body: unknown[] | Settings) => ref(table).set(Array.isArray(body) ? { rows: body } : { ...body }).catch((e: { code?: string; message?: string }) => {
    throw new Error(e?.code === 'invalid_argument'
      ? 'Você só tem permissão para ver esta página, não para salvar.'
      : `Não foi possível salvar (${e?.code ?? e?.message ?? 'erro'}). Tente de novo.`)
  })
  return {
    async list(table) {
      const rows = await read(table)
      return rows.sort((a, b) => a.name.localeCompare(b.name)) as never
    },
    async save(table, row) {
      const rows = await read(table)
      const saved = { ...row, id: row.id ?? crypto.randomUUID() }
      const i = rows.findIndex((r) => r.id === saved.id)
      if (i >= 0) rows[i] = saved as never
      else rows.push(saved as never)
      await write(table, rows)
      return saved as never
    },
    async remove(table, id) {
      await write(table, (await read(table)).filter((r) => r.id !== id))
    },
    async replaceAll(table, rows) {
      await write(table, rows)
    },
    async getSettings() {
      const snap = await ref('settings').get()
      return toSettings(snap.exists ? snap.data() : null)
    },
    async saveSettings(settings) {
      await write('settings', settings)
    },
  }
}

export type StoreMode = 'supabase' | 'cloud' | 'local'
let active: Store = supabase ? supabaseStore(supabase) : localStore

/** Escolhe onde salvar: Supabase (se configurado), nuvem do Claude ou navegador. */
export async function initStore(): Promise<StoreMode> {
  if (supabase) return 'supabase'
  try {
    const cloud = await claudeStore()
    if (cloud) {
      active = cloud
      return 'cloud'
    }
  } catch {
    /* sem nuvem: usa o navegador */
  }
  return 'local'
}

export const store: Store = {
  list: (table) => active.list(table),
  save: (table, row) => active.save(table, row),
  remove: (table, id) => active.remove(table, id),
  replaceAll: (table, rows) => active.replaceAll(table, rows),
  getSettings: () => active.getSettings(),
  saveSettings: (settings) => active.saveSettings(settings),
}

/** Cria ingredientes e uma receita de exemplo. */
export async function loadExamples() {
  const specs: [string, Ingredient['unit'], number, number][] = [
    ['Cebola (exemplo)', 'kg', 5.99, 1],
    ['Óleo de girassol (exemplo)', 'l', 9.5, 0.9],
    ['Farinha de trigo (exemplo)', 'kg', 4.8, 1],
    ['Sal (exemplo)', 'kg', 2.5, 1],
    ['Embalagem 100g (exemplo)', 'un', 35, 100],
  ]
  const ids: string[] = []
  for (const [name, unit, package_price, package_qty] of specs) {
    ids.push((await store.save('ingredients', { name, unit, package_price, package_qty })).id)
  }
  await store.save('recipes', {
    name: 'Onion chips 100g (exemplo)',
    yield_qty: 12,
    yield_label: 'pacotes',
    extra_costs: 6,
    margin_pct: 120,
    sale_price: 9.9,
    notes: 'Receita de exemplo. Edite ou exclua à vontade.',
    items: [
      { ingredient_id: ids[0], quantity: 3, unit: 'kg' },
      { ingredient_id: ids[1], quantity: 600, unit: 'ml' },
      { ingredient_id: ids[2], quantity: 400, unit: 'g' },
      { ingredient_id: ids[3], quantity: 30, unit: 'g' },
      { ingredient_id: ids[4], quantity: 12, unit: 'un' },
    ],
  })
}
