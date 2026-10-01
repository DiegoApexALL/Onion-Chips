export type Unit = 'g' | 'kg' | 'ml' | 'l' | 'un'

export interface Ingredient {
  id: string
  name: string
  unit: Unit
  package_price: number
  package_qty: number
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
}
