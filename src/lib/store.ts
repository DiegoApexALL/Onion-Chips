import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import type { Ingredient, Recipe } from './types'

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined
const key = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined

export const supabase: SupabaseClient | null = url && key ? createClient(url, key) : null

type Table = 'ingredients' | 'recipes'
type Row<T extends Table> = T extends 'ingredients' ? Ingredient : Recipe

export interface Store {
  list<T extends Table>(table: T): Promise<Row<T>[]>
  save<T extends Table>(table: T, row: Omit<Row<T>, 'id'> & { id?: string }): Promise<Row<T>>
  remove(table: Table, id: string): Promise<void>
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
})

// Modo local (sem Supabase configurado): salva no navegador
const localStore: Store = {
  async list(table) {
    try {
      const rows = JSON.parse(localStorage.getItem(`onion-cost:${table}`) || '[]')
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
    localStorage.setItem(`onion-cost:${table}`, JSON.stringify(rows))
    return saved as never
  },
  async remove(table, id) {
    const rows = (await localStore.list(table)) as { id: string }[]
    localStorage.setItem(`onion-cost:${table}`, JSON.stringify(rows.filter((r) => r.id !== id)))
  },
}

export const store: Store = supabase ? supabaseStore(supabase) : localStore
