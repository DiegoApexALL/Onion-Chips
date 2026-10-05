import { useEffect, useState, type FormEvent } from 'react'
import { CmvValue } from '../CmvBadge'
import BackupCard from './BackupCard'
import { CmvChart, CostBreakdown, Metrics } from './Charts'
import { cmvStatus, money, pct, recipeCost } from '../lib/cost'
import type { Ingredient, Recipe, Settings } from '../lib/types'

interface Props {
  ingredients: Ingredient[]
  recipes: Recipe[]
  settings: Settings
  onSaveSettings: (s: Settings) => Promise<void>
  onGo: (tab: 'ingredients' | 'recipes') => void
  onExamples: () => Promise<void>
  onRestored: () => Promise<void>
}

export default function Dashboard({ ingredients, recipes, settings, onSaveSettings, onGo, onExamples, onRestored }: Props) {
  const [loading, setLoading] = useState(false)
  const rows = recipes.map((r) => ({ r, c: recipeCost(r, ingredients) }))
  const priced = rows.filter((x) => x.c.cmvPct != null)
  const avgCmv = priced.length ? priced.reduce((s, x) => s + x.c.cmvPct!, 0) / priced.length : null
  const avgStatus = cmvStatus(avgCmv, settings)

  if (!ingredients.length && !recipes.length) {
    return (
      <>
      <div className="card empty">
        <h2>Bem-vindo! 👋</h2>
        <p>Comece cadastrando seus ingredientes (ex.: cebola, óleo, sal, embalagem) com o preço que você paga.</p>
        <p>Depois monte uma receita dizendo quanto de cada ingrediente usa e quantas unidades ela rende.</p>
        <div className="actions center-actions">
          <button className="primary" onClick={() => onGo('ingredients')}>
            Cadastrar ingredientes
          </button>
          <button className="ghost" disabled={loading} onClick={async () => { setLoading(true); await onExamples(); setLoading(false) }}>
            {loading ? 'Carregando…' : 'Carregar exemplo de onion chips'}
          </button>
        </div>
      </div>
      <BackupCard onRestored={onRestored} />
      </>
    )
  }

  return (
    <>
      <div className="stats">
        <Stat label="Ingredientes" value={String(ingredients.length)} />
        <Stat label="Receitas" value={String(recipes.length)} />
        <Stat label="CMV médio" value={avgCmv == null ? '—' : pct(avgCmv)} tone={avgStatus} />
      </div>
      <Metrics ingredients={ingredients} recipes={recipes} settings={settings} />
      <div className="chart-grid">
        <CmvChart ingredients={ingredients} recipes={recipes} settings={settings} />
        <CostBreakdown ingredients={ingredients} recipes={recipes} />
      </div>
      <section className="card">
        <div className="row-between">
          <h2>Resumo das receitas</h2>
          <button className="ghost small" onClick={() => onGo('recipes')}>
            Ver receitas
          </button>
        </div>
        {rows.length === 0 ? (
          <p className="muted">Nenhuma receita ainda.</p>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Receita</th>
                  <th className="num">Custo/un</th>
                  <th className="num">Preço sugerido</th>
                  <th className="num">Preço atual</th>
                  <th className="num">CMV</th>
                  <th className="num">Lucro/un</th>
                </tr>
              </thead>
              <tbody>
                {rows.map(({ r, c }) => (
                  <tr key={r.id}>
                    <td>{r.name}</td>
                    <td className="num">{money(c.unitCost)}</td>
                    <td className="num">{money(c.suggestedPrice)}</td>
                    <td className="num">{c.salePrice == null ? '—' : money(c.salePrice)}</td>
                    <td className="num"><CmvValue cmv={c.cmvPct} settings={settings} /></td>
                    <td className={`num ${c.unitProfit != null && c.unitProfit < 0 ? 'neg' : 'pos'}`}>
                      {c.unitProfit == null ? '—' : money(c.unitProfit)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      <CmvTarget settings={settings} onSave={onSaveSettings} />
      <BackupCard onRestored={onRestored} />
    </>
  )
}

function CmvTarget({ settings, onSave }: { settings: Settings; onSave: (s: Settings) => Promise<void> }) {
  const [min, setMin] = useState(String(settings.cmv_min))
  const [max, setMax] = useState(String(settings.cmv_max))
  const [busy, setBusy] = useState(false)
  const [saved, setSaved] = useState(false)
  useEffect(() => {
    setMin(String(settings.cmv_min))
    setMax(String(settings.cmv_max))
  }, [settings.cmv_min, settings.cmv_max])

  const nMin = Number(min)
  const nMax = Number(max)
  const invalid = !(min !== '' && max !== '' && nMin > 0 && nMax <= 100 && nMin <= nMax)
  const changed = nMin !== settings.cmv_min || nMax !== settings.cmv_max

  async function submit(e: FormEvent) {
    e.preventDefault()
    if (invalid) return
    setBusy(true)
    await onSave({ cmv_min: nMin, cmv_max: nMax })
    setBusy(false)
    setSaved(true)
    setTimeout(() => setSaved(false), 2500)
  }

  return (
    <form className="card cmv-target" onSubmit={submit}>
      <div>
        <h2>Meta de CMV</h2>
        <p className="muted small">Faixa ideal do custo sobre o preço de venda. Receitas fora dela ficam marcadas.</p>
      </div>
      <div className="cmv-inputs">
        <label htmlFor="cmv-min">
          Mínimo (%)
          <input id="cmv-min" type="number" min="1" max="100" step="any" value={min} onChange={(e) => setMin(e.target.value)} />
        </label>
        <label htmlFor="cmv-max">
          Máximo (%)
          <input id="cmv-max" type="number" min="1" max="100" step="any" value={max} onChange={(e) => setMax(e.target.value)} />
        </label>
        <button className="primary" disabled={busy || invalid || !changed}>
          {saved ? 'Salvo' : 'Salvar meta'}
        </button>
      </div>
      {invalid && <p className="neg small">O mínimo precisa ser maior que 0 e menor ou igual ao máximo (até 100%).</p>}
    </form>
  )
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: string | null }) {
  return (
    <div className="card stat">
      <div className="muted small">{label}</div>
      <div className={`stat-value${tone ? ` tone-${tone}` : ''}`}>{value}</div>
    </div>
  )
}
