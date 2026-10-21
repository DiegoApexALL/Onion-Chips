import type { Channel, Ingredient, Recipe, Settings, Unit } from './types'

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
  /** CMV %: custo por unidade ÷ preço atual × 100 */
  cmvPct: number | null
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
  const cmvPct = salePrice != null && salePrice > 0 ? (unitCost / salePrice) * 100 : null
  return { ingredientsCost, batchCost, unitCost, suggestedPrice, salePrice, unitProfit, realMarginPct, cmvPct }
}

const brl = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' })
export const money = (n: number) => brl.format(Number.isFinite(n) ? n : 0)
export const money4 = (n: number) =>
  new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL', maximumFractionDigits: 4 }).format(n)
export const pct = (n: number) => `${n.toLocaleString('pt-BR', { maximumFractionDigits: 1 })}%`

export type CmvStatus = 'ok' | 'high' | 'low'

/** Compara o CMV com a meta: acima do máximo = custo pesado demais no preço. */
export function cmvStatus(cmv: number | null, s: Settings): CmvStatus | null {
  if (cmv == null) return null
  if (cmv > s.cmv_max) return 'high'
  if (cmv < s.cmv_min) return 'low'
  return 'ok'
}

export const CMV_LABEL: Record<CmvStatus, string> = { ok: 'Na meta', high: 'Acima da meta', low: 'Abaixo da meta' }

/** Faixa de preço que deixa o CMV dentro da meta (preço = custo ÷ CMV). */
export function priceRangeForCmv(unitCost: number, s: Settings): [number, number] | null {
  if (unitCost <= 0 || s.cmv_min <= 0 || s.cmv_max <= 0) return null
  return [unitCost / (s.cmv_max / 100), unitCost / (s.cmv_min / 100)]
}

export interface ChannelPrice {
  channel: Channel
  /** Preço sugerido da receita (custo/un × margem), base para calcular a comissão do canal */
  basePrice: number
  /** Soma dos percentuais do canal (comissão, pagamento, cupom, imposto) */
  feesPct: number
  /** Taxas percentuais em R$, calculadas sobre o preço sugerido da receita */
  feesValue: number
  /** Custo do canal em R$: taxas + embalagem (se usa) + taxa fixa */
  channelCost: number
  /** Custo da receita + custo do canal */
  totalCost: number
  /** (custo da receita + custo do canal) × (1 + margem da receita) */
  suggestedPrice: number
  /** Sugerido arredondado para cima terminando em ,90 */
  roundedPrice: number
  /** Menor preço sem prejuízo nesse canal (cobre custo, embalagem, taxa fixa e taxas %). null se as taxas somam 100% ou mais. */
  minPrice: number | null
  /** Preço praticado hoje nesse canal (se informado) */
  currentPrice: number | null
  /** Quanto sobra por venda no preço praticado (ou no sugerido, se não houver preço praticado) */
  profit: number | null
  profitPct: number | null
}

/** Arredonda para cima terminando em ,90 (28,99 → 29,90). */
export function roundTo90(price: number): number {
  return Math.max(0.9, Math.ceil(price - 0.9 - 1e-9) + 0.9)
}

type ChannelRecipe = Pick<Recipe, 'margin_pct' | 'packaging_cost' | 'channel_prices'>

/**
 * Preço por canal, a partir do custo que já está na receita:
 * custo do canal = taxas % (sobre o preço sugerido da receita) + embalagem + taxa fixa;
 * sugerido no canal = (custo da receita + custo do canal) × (1 + margem da receita).
 */
export function channelPrice(unitCost: number, recipe: ChannelRecipe, channel: Channel, s: Settings): ChannelPrice {
  const markup = 1 + (recipe.margin_pct || 0) / 100
  const basePrice = unitCost * markup
  const feesPct = (channel.commission_pct || 0) + (channel.payment_pct || 0) + (channel.discount_pct || 0) + (s.tax_pct || 0)
  const feesValue = basePrice * feesPct / 100
  const fixedCosts = (channel.uses_packaging ? recipe.packaging_cost || 0 : 0) + (channel.fixed_fee || 0)
  const channelCost = feesValue + fixedCosts
  const totalCost = unitCost + channelCost
  const suggestedPrice = totalCost * markup
  const roundedPrice = roundTo90(suggestedPrice)
  const minPrice = feesPct < 100 ? (unitCost + fixedCosts) / (1 - feesPct / 100) : null
  const raw = recipe.channel_prices?.[channel.id]
  const currentPrice = raw != null && Number.isFinite(raw) && raw > 0 ? raw : null
  const price = currentPrice ?? suggestedPrice
  // No lucro real, a comissão do app incide sobre o preço cobrado no canal
  const profit = price * (1 - feesPct / 100) - unitCost - fixedCosts
  const profitPct = price ? (profit / price) * 100 : null
  return { channel, basePrice, feesPct, feesValue, channelCost, totalCost, suggestedPrice, roundedPrice, minPrice, currentPrice, profit, profitPct }
}

export function channelPrices(unitCost: number, recipe: ChannelRecipe, s: Settings): ChannelPrice[] {
  return s.channels.map((ch) => channelPrice(unitCost, recipe, ch, s))
}
