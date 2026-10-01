import type { Ingredient, Recipe, Unit } from './types'

export const UNITS: { value: Unit; label: string }[] = [
  { value: 'g', label: 'g' },
  { value: 'kg', label: 'kg' },
  { value: 'ml', label: 'ml' },
  { value: 'l', label: 'L' },
  { value: 'un', label: 'un' },
]

// Fator para a unidade base da família (g, ml ou un)
const FACTOR: Record<Unit, number> = { g: 1, kg: 1000, ml: 1, l: 1000, un: 1 }
const FAMILY: Record<Unit, string> = { g: 'mass', kg: 'mass', ml: 'vol', l: 'vol', un: 'count' }

export function compatibleUnits(unit: Unit): Unit[] {
  return UNITS.map((u) => u.value).filter((u) => FAMILY[u] === FAMILY[unit])
}

/** Custo por unidade base (g, ml ou un) */
export function costPerBase(ing: Ingredient): number {
  return ing.package_price / (ing.package_qty * FACTOR[ing.unit])
}

export function itemCost(ing: Ingredient | undefined, quantity: number, unit: Unit): number {
  if (!ing || FAMILY[ing.unit] !== FAMILY[unit]) return 0
  return costPerBase(ing) * quantity * FACTOR[unit]
}

export interface RecipeCost {
  ingredientsCost: number
  batchCost: number
  unitCost: number
  suggestedPrice: number
  salePrice: number | null
  unitProfit: number | null
  realMarginPct: number | null
}

export function recipeCost(recipe: Recipe, ingredients: Ingredient[]): RecipeCost {
  const byId = new Map(ingredients.map((i) => [i.id, i]))
  const ingredientsCost = recipe.items.reduce(
    (sum, it) => sum + itemCost(byId.get(it.ingredient_id), it.quantity, it.unit),
    0,
  )
  const batchCost = ingredientsCost + (recipe.extra_costs || 0)
  const unitCost = recipe.yield_qty > 0 ? batchCost / recipe.yield_qty : 0
  const suggestedPrice = unitCost * (1 + (recipe.margin_pct || 0) / 100)
  const salePrice = recipe.sale_price ?? null
  const unitProfit = salePrice != null ? salePrice - unitCost : null
  const realMarginPct = salePrice != null && unitCost > 0 ? ((salePrice - unitCost) / unitCost) * 100 : null
  return { ingredientsCost, batchCost, unitCost, suggestedPrice, salePrice, unitProfit, realMarginPct }
}

const brl = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' })
export const money = (n: number) => brl.format(Number.isFinite(n) ? n : 0)
export const money4 = (n: number) =>
  new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL', maximumFractionDigits: 4 }).format(n)
export const pct = (n: number) => `${n.toLocaleString('pt-BR', { maximumFractionDigits: 1 })}%`
