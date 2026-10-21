export type Unit = 'g' | 'kg' | 'ml' | 'l' | 'un'

export interface Ingredient {
  id: string
  name: string
  unit: Unit
  package_price: number
  package_qty: number
  /** Contagem da loja (só no banco): entra na lista diária / na semanal geral */
  contar_diaria?: boolean
  contar_semanal?: boolean
}

export interface RecipeItem {
  ingredient_id: string
  quantity: number
  unit: Unit
}

export interface Recipe {
  id: string
  name: string
  yield_qty: number
  yield_label: string
  extra_costs: number
  margin_pct: number
  sale_price: number | null
  notes: string | null
  items: RecipeItem[]
  /** Embalagem de delivery por unidade vendida (R$). Só entra nos canais que usam embalagem. */
  packaging_cost?: number
  /** Preço praticado hoje em cada canal: { [channel.id]: preço } */
  channel_prices?: Record<string, number>
}

/** Canal de venda (iFood, 99Food, Keeta, balcão…). Percentuais sobre o preço de venda. */
export interface Channel {
  id: string
  name: string
  commission_pct: number
  payment_pct: number
  /** Taxa fixa cobrada por pedido (R$) */
  fixed_fee: number
  /** Cupom/desconto que a loja banca (%) */
  discount_pct: number
  uses_packaging: boolean
}

export interface Settings {
  cmv_min: number
  cmv_max: number
  /** Canais de delivery/venda com as taxas de cada um */
  channels: Channel[]
  /** Imposto sobre a venda (%), ex.: alíquota do Simples */
  tax_pct: number
  /** Lucro desejado sobre o preço de venda (%) nos canais */
  channel_margin_pct: number
}

export const DEFAULT_SETTINGS: Settings = { cmv_min: 30, cmv_max: 40, channels: [], tax_pct: 0, channel_margin_pct: 20 }
