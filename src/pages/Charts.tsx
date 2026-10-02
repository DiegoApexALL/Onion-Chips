import { useState } from 'react'
import { CMV_LABEL, cmvStatus, itemCost, money, pct, recipeCost } from '../lib/cost'
import type { Ingredient, Recipe, Settings } from '../lib/types'

interface Props {
  ingredients: Ingredient[]
  recipes: Recipe[]
  settings: Settings
}

const niceMax = (v: number) => Math.max(10, Math.ceil(v / 10) * 10)

/** Métricas rápidas do negócio. */
export function Metrics({ ingredients, recipes, settings }: Props) {
  const rows = recipes.map((r) => ({ r, c: recipeCost(r, ingredients) }))
  const priced = rows.filter((x) => x.c.cmvPct != null)
  const onTarget = priced.filter((x) => cmvStatus(x.c.cmvPct, settings) === 'ok').length
  const avgProfit = priced.length ? priced.reduce((s, x) => s + x.c.unitProfit!, 0) / priced.length : null
  const worst = priced.reduce<(typeof priced)[number] | null>((w, x) => (!w || x.c.cmvPct! > w.c.cmvPct! ? x : w), null)

  // Ingrediente que mais pesa: soma do custo por unidade em todas as receitas
  const byIng = new Map(ingredients.map((i) => [i.id, i]))
  const weight = new Map<string, number>()
  for (const r of recipes) {
    if (r.yield_qty <= 0) continue
    for (const it of r.items) {
      const v = itemCost(byIng.get(it.ingredient_id), it.quantity, it.unit) / r.yield_qty
      weight.set(it.ingredient_id, (weight.get(it.ingredient_id) ?? 0) + v)
    }
  }
  const heaviest = [...weight.entries()].sort((a, b) => b[1] - a[1])[0]

  return (
    <div className="metrics">
      <Metric label="Receitas na meta de CMV" value={priced.length ? `${onTarget} de ${priced.length}` : '—'}
        note={priced.length ? `Meta ${pct(settings.cmv_min)} a ${pct(settings.cmv_max)}` : 'Preencha o preço atual nas receitas'} />
      <Metric label="Lucro médio por unidade" value={avgProfit == null ? '—' : money(avgProfit)}
        note="Com o preço atual" tone={avgProfit != null && avgProfit < 0 ? 'high' : undefined} />
      <Metric label="Maior CMV" value={worst ? pct(worst.c.cmvPct!) : '—'} note={worst?.r.name ?? 'Sem preço atual'}
        tone={worst ? cmvStatus(worst.c.cmvPct, settings) : undefined} />
      <Metric label="Ingrediente que mais pesa" value={heaviest ? byIng.get(heaviest[0])?.name ?? '—' : '—'}
        note={heaviest ? `${money(heaviest[1])} por unidade, somando as receitas` : 'Sem receitas'} small />
    </div>
  )
}

function Metric({ label, value, note, tone, small }: { label: string; value: string; note: string; tone?: string | null; small?: boolean }) {
  return (
    <div className="card metric">
      <div className="muted small">{label}</div>
      <div className={`metric-value${small ? ' metric-text' : ''}${tone ? ` tone-${tone}` : ''}`}>{value}</div>
      <div className="muted small metric-note">{note}</div>
    </div>
  )
}

/** CMV de cada receita contra a faixa da meta. */
export function CmvChart({ ingredients, recipes, settings }: Props) {
  const rows = recipes
    .map((r) => ({ r, c: recipeCost(r, ingredients) }))
    .filter((x) => x.c.cmvPct != null)
    .sort((a, b) => b.c.cmvPct! - a.c.cmvPct!)
  if (!rows.length) return null
  const max = niceMax(Math.max(settings.cmv_max, ...rows.map((x) => x.c.cmvPct!)) * 1.05)
  const x = (v: number) => `${Math.min(100, (v / max) * 100)}%`
  const ticks = [0, max / 2, max]

  return (
    <section className="card chart">
      <h2>CMV por receita</h2>
      <p className="muted small">
        A faixa sombreada é a meta ({pct(settings.cmv_min)} a {pct(settings.cmv_max)}). Barra passando da faixa = custo alto para o preço.
      </p>
      <div className="hbars" role="list">
        {rows.map(({ r, c }) => {
          const status = cmvStatus(c.cmvPct, settings)!
          return (
            <div key={r.id} className="hbar-row" role="listitem"
              title={`${r.name}: CMV ${pct(c.cmvPct!)} (${CMV_LABEL[status]}) · custo ${money(c.unitCost)} · preço ${money(c.salePrice!)}`}>
              <div className="hbar-label">{r.name}</div>
              <div className="hbar-track">
                <div className="hbar-band" style={{ left: x(settings.cmv_min), width: `calc(${x(settings.cmv_max)} - ${x(settings.cmv_min)})` }} />
                <div className="hbar-fill" style={{ width: x(c.cmvPct!) }} />
              </div>
              <div className="hbar-value">
                {pct(c.cmvPct!)} <span className={`chip chip-${status}`}>{CMV_LABEL[status]}</span>
              </div>
            </div>
          )
        })}
        <div className="hbar-row hbar-axis" aria-hidden="true">
          <div />
          <div className="hbar-ticks">
            {ticks.map((t) => <span key={t} style={{ left: x(t) }}>{pct(t)}</span>)}
          </div>
          <div />
        </div>
      </div>
    </section>
  )
}

/** De onde vem o custo de uma receita. */
export function CostBreakdown({ ingredients, recipes }: Omit<Props, 'settings'>) {
  const [selected, setSelected] = useState<string>('')
  const recipe = recipes.find((r) => r.id === selected) ?? recipes[0]
  if (!recipe) return null
  const c = recipeCost(recipe, ingredients)
  const byIng = new Map(ingredients.map((i) => [i.id, i]))
  const parts = recipe.items.map((it) => ({
    name: byIng.get(it.ingredient_id)?.name ?? '(ingrediente excluído)',
    value: itemCost(byIng.get(it.ingredient_id), it.quantity, it.unit) / recipe.yield_qty,
  }))
  if (recipe.extra_costs > 0) parts.push({ name: 'Outros custos', value: recipe.extra_costs / recipe.yield_qty })
  parts.sort((a, b) => b.value - a.value)
  const share = (v: number) => (c.unitCost > 0 ? (v / c.unitCost) * 100 : 0)
  const max = niceMax(Math.max(0, ...parts.map((p) => share(p.value))))

  return (
    <section className="card chart">
      <div className="row-between">
        <h2>Composição do custo</h2>
        {recipes.length > 1 && (
          <select id="breakdown-recipe" className="compact" value={recipe.id} onChange={(e) => setSelected(e.target.value)}
            aria-label="Receita">
            {recipes.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
          </select>
        )}
      </div>
      <p className="muted small">
        Quanto cada item pesa no custo de {money(c.unitCost)} por {recipe.yield_label.replace(/s$/, '') || 'unidade'}.
      </p>
      {parts.length === 0 ? (
        <p className="muted">Essa receita ainda não tem ingredientes.</p>
      ) : (
        <div className="hbars" role="list">
          {parts.map((p) => (
            <div key={p.name} className="hbar-row" role="listitem" title={`${p.name}: ${money(p.value)} (${pct(share(p.value))})`}>
              <div className="hbar-label">{p.name}</div>
              <div className="hbar-track">
                <div className="hbar-fill" style={{ width: `${(share(p.value) / max) * 100}%` }} />
              </div>
              <div className="hbar-value">{pct(share(p.value))} <span className="muted">· {money(p.value)}</span></div>
            </div>
          ))}
        </div>
      )}
    </section>
  )
}
