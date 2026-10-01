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

// Dados de exemplo na primeira visita, para o app não abrir vazio
function seedExamples() {
  if (read('onion-cost:seeded')) return
  const ing = (name: string, unit: Ingredient['unit'], package_price: number, package_qty: number): Ingredient => ({
    id: crypto.randomUUID(), name, unit, package_price, package_qty,
  })
  const cebola = ing('Cebola (exemplo)', 'kg', 5.99, 1)
  const oleo = ing('Óleo de girassol (exemplo)', 'l', 9.5, 0.9)
  const farinha = ing('Farinha de trigo (exemplo)', 'kg', 4.8, 1)
  const sal = ing('Sal (exemplo)', 'kg', 2.5, 1)
  const pacote = ing('Embalagem 100g (exemplo)', 'un', 35, 100)
  const recipe: Recipe = {
    id: crypto.randomUUID(),
    name: 'Onion chips 100g (exemplo)',
    yield_qty: 12,
    yield_label: 'pacotes',
    extra_costs: 6,
    margin_pct: 120,
    sale_price: 9.9,
    notes: 'Receita de exemplo. Edite ou exclua à vontade.',
    items: [
      { ingredient_id: cebola.id, quantity: 3, unit: 'kg' },
      { ingredient_id: oleo.id, quantity: 600, unit: 'ml' },
      { ingredient_id: farinha.id, quantity: 400, unit: 'g' },
      { ingredient_id: sal.id, quantity: 30, unit: 'g' },
      { ingredient_id: pacote.id, quantity: 12, unit: 'un' },
    ],
  }
  write('onion-cost:ingredients', JSON.stringify([cebola, oleo, farinha, sal, pacote]))
  write('onion-cost:recipes', JSON.stringify([recipe]))
  write('onion-cost:seeded', '1')
}

const localStore: Store = {
  async list(table) {
    seedExamples()
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
}

export const store: Store = supabase ? supabaseStore(supabase) : localStore
