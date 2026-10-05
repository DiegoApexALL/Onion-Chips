import { Capacitor } from '@capacitor/core'
import { store } from './store'
import type { Ingredient, Recipe, Settings, Unit } from './types'

export interface Backup {
  app: 'onion-cost'
  version: 1
  exported_at: string
  ingredients: Ingredient[]
  recipes: Recipe[]
  settings: Settings
}

export async function createBackup(): Promise<Backup> {
  const [ingredients, recipes, settings] = await Promise.all([
    store.list('ingredients'),
    store.list('recipes'),
    store.getSettings(),
  ])
  return { app: 'onion-cost', version: 1, exported_at: new Date().toISOString(), ingredients, recipes, settings }
}

export function backupFilename(date = new Date()) {
  const d = date.toISOString().slice(0, 10)
  return `onion-cost-backup-${d}.json`
}

const UNITS: Unit[] = ['g', 'kg', 'ml', 'l', 'un']
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : Number(v))
const str = (v: unknown) => (typeof v === 'string' ? v : '')

/** Lê e valida um backup. Lança um erro com mensagem amigável se o texto não for um backup válido. */
export function parseBackup(text: string): Backup {
  let raw: Record<string, unknown>
  try {
    raw = JSON.parse(text.trim())
  } catch {
    throw new Error('Esse texto não é um backup do Onion Cost. Confira se copiou o código inteiro.')
  }
  if (!raw || raw.app !== 'onion-cost' || !Array.isArray(raw.ingredients) || !Array.isArray(raw.recipes)) {
    throw new Error('Esse arquivo não é um backup do Onion Cost.')
  }
  const ingredients: Ingredient[] = (raw.ingredients as Record<string, unknown>[]).map((i) => {
    const unit = UNITS.includes(i.unit as Unit) ? (i.unit as Unit) : null
    if (!str(i.id) || !str(i.name) || !unit || !(num(i.package_qty) > 0) || !(num(i.package_price) >= 0)) {
      throw new Error(`Ingrediente inválido no backup: ${str(i.name) || '(sem nome)'}.`)
    }
    return { id: str(i.id), name: str(i.name), unit, package_price: num(i.package_price), package_qty: num(i.package_qty) }
  })
  const recipes: Recipe[] = (raw.recipes as Record<string, unknown>[]).map((r) => {
    if (!str(r.id) || !str(r.name) || !(num(r.yield_qty) > 0) || !Array.isArray(r.items)) {
      throw new Error(`Receita inválida no backup: ${str(r.name) || '(sem nome)'}.`)
    }
    return {
      id: str(r.id),
      name: str(r.name),
      yield_qty: num(r.yield_qty),
      yield_label: str(r.yield_label) || 'pacotes',
      extra_costs: num(r.extra_costs) || 0,
      margin_pct: num(r.margin_pct) || 0,
      sale_price: r.sale_price == null || r.sale_price === '' ? null : num(r.sale_price),
      notes: r.notes == null ? null : str(r.notes),
      items: (r.items as Record<string, unknown>[]).map((it) => ({
        ingredient_id: str(it.ingredient_id),
        quantity: num(it.quantity) || 0,
        unit: UNITS.includes(it.unit as Unit) ? (it.unit as Unit) : 'g',
      })),
    }
  })
  const s = (raw.settings ?? {}) as Record<string, unknown>
  const settings: Settings = {
    cmv_min: num(s.cmv_min) > 0 ? num(s.cmv_min) : 30,
    cmv_max: num(s.cmv_max) > 0 ? num(s.cmv_max) : 40,
  }
  return { app: 'onion-cost', version: 1, exported_at: str(raw.exported_at), ingredients, recipes, settings }
}

/** Substitui todos os dados atuais pelos do backup. */
export async function restoreBackup(b: Backup) {
  await store.replaceAll('recipes', [])
  await store.replaceAll('ingredients', b.ingredients)
  await store.replaceAll('recipes', b.recipes)
  await store.saveSettings(b.settings)
}

interface Downloads {
  save(req: { filename: string; data: string }): Promise<unknown>
}

/**
 * Salva o backup como arquivo, do jeito que cada lugar permite:
 * no app Android abre o menu de compartilhar; na página do Claude usa o salvamento de arquivos;
 * no navegador comum baixa o arquivo.
 * Retorna false quando nenhum desses caminhos está disponível.
 */
export async function saveBackupFile(json: string, filename: string): Promise<boolean> {
  if (Capacitor.isNativePlatform()) {
    const { Filesystem, Directory, Encoding } = await import('@capacitor/filesystem')
    const { Share } = await import('@capacitor/share')
    const { uri } = await Filesystem.writeFile({ path: filename, data: json, directory: Directory.Cache, encoding: Encoding.UTF8 })
    await Share.share({ title: 'Backup do Onion Cost', files: [uri], dialogTitle: 'Guardar backup' })
    return true
  }
  const claude = (window as unknown as { claude?: { use(n: 'downloads'): Promise<Downloads | null> } }).claude
  if (claude?.use) {
    const downloads = await claude.use('downloads')
    if (!downloads) return false
    await downloads.save({ filename, data: json })
    return true
  }
  const url = URL.createObjectURL(new Blob([json], { type: 'application/json' }))
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
  return true
}
