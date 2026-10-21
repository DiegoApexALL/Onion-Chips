import { useEffect, useState, type FormEvent } from 'react'
import { channelPrices, money, pct, type ChannelPrice } from '../lib/cost'
import type { Channel, Recipe, Settings } from '../lib/types'

const blank = (name: string, uses_packaging = true): Channel => ({
  id: crypto.randomUUID(), name, commission_pct: 0, payment_pct: 0, fixed_fee: 0, discount_pct: 0, uses_packaging,
})

/** Canais sugeridos quando ainda não há nenhum: as taxas ficam zeradas para preencher com as do contrato. */
const starter = (): Channel[] => [blank('iFood'), blank('99Food'), blank('Keeta')]

/** Configuração das taxas de cada app de delivery (vale para todas as receitas). */
export function ChannelConfig({ settings, onSave }: { settings: Settings; onSave: (s: Settings) => Promise<void> }) {
  const fresh = () => ({
    channels: settings.channels.length ? structuredClone(settings.channels) : starter(),
    tax: String(settings.tax_pct),
  })
  const [form, setForm] = useState(fresh)
  const [busy, setBusy] = useState(false)
  const [saved, setSaved] = useState(false)
  useEffect(() => setForm(fresh()), [settings])

  const setCh = (i: number, patch: Partial<Channel>) =>
    setForm({ ...form, channels: form.channels.map((c, j) => (j === i ? { ...c, ...patch } : c)) })

  const tax = Number(form.tax)
  const over = form.channels.find((c) => c.commission_pct + c.payment_pct + c.discount_pct + tax >= 100)
  const invalid = form.tax === '' || tax < 0 || form.channels.some((c) => !c.name.trim()) || !!over
  const unsaved = !settings.channels.length

  async function submit(e: FormEvent) {
    e.preventDefault()
    if (invalid) return
    setBusy(true)
    await onSave({ ...settings, channels: form.channels.map((c) => ({ ...c, name: c.name.trim() })), tax_pct: tax })
    setBusy(false)
    setSaved(true)
    setTimeout(() => setSaved(false), 2500)
  }

  const numInput = (value: number, onChange: (v: number) => void, label: string, step = 'any') => (
    <input type="number" min="0" step={step} aria-label={label} value={Number.isFinite(value) ? value : ''}
      onChange={(e) => onChange(e.target.value === '' ? 0 : Number(e.target.value))} />
  )

  return (
    <form className="card channel-config" onSubmit={submit}>
      <div>
        <h2>Taxas de delivery</h2>
        <p className="muted small">
          As taxas de cada app valem para todas as receitas. Quando um app mudar a comissão, altere aqui e todos os preços se recalculam.
          Use os valores do seu contrato (entrega própria ou entrega do app têm taxas diferentes).
        </p>
      </div>
      {unsaved && <div className="hint">Preencha as taxas de cada app e toque em Salvar para ver os preços por canal nas receitas.</div>}

      <div className="channel-list">
        {form.channels.map((c, i) => (
          <fieldset key={c.id} className="channel-row">
            <label className="ch-name">
              Canal
              <input required value={c.name} onChange={(e) => setCh(i, { name: e.target.value })} />
            </label>
            <label>Comissão (%){numInput(c.commission_pct, (v) => setCh(i, { commission_pct: v }), 'Comissão')}</label>
            <label>Pagamento online (%){numInput(c.payment_pct, (v) => setCh(i, { payment_pct: v }), 'Pagamento online')}</label>
            <label>Cupom que você banca (%){numInput(c.discount_pct, (v) => setCh(i, { discount_pct: v }), 'Cupom')}</label>
            <label>Taxa fixa por pedido (R$){numInput(c.fixed_fee, (v) => setCh(i, { fixed_fee: v }), 'Taxa fixa', '0.01')}</label>
            <label className="inline-label ch-pack">
              <input type="checkbox" checked={c.uses_packaging} onChange={(e) => setCh(i, { uses_packaging: e.target.checked })} />
              Usa embalagem de delivery
            </label>
            <button type="button" className="danger small ch-remove" aria-label={`Remover ${c.name}`}
              onClick={() => setForm({ ...form, channels: form.channels.filter((_, j) => j !== i) })}>✕</button>
          </fieldset>
        ))}
      </div>
      <div className="actions start">
        <button type="button" className="ghost small" onClick={() => setForm({ ...form, channels: [...form.channels, blank('Balcão / WhatsApp', false)] })}>
          + Adicionar canal
        </button>
      </div>

      <div className="cmv-inputs">
        <label>
          Imposto sobre a venda (%)
          <input type="number" min="0" max="99" step="any" value={form.tax} onChange={(e) => setForm({ ...form, tax: e.target.value })} />
        </label>
        <button className="primary" disabled={busy || invalid}>{saved ? 'Salvo' : 'Salvar taxas'}</button>
      </div>
      {over && <p className="neg small">Em {over.name || 'um canal'}, taxas + imposto somam 100% ou mais.</p>}
      <p className="muted small">
        Custo do canal = taxas % sobre o preço sugerido da receita + embalagem + taxa fixa.
        Sugerido no canal = (custo da receita + custo do canal) × a margem de cada receita.
      </p>
    </form>
  )
}

/** Tabela de preços por canal de uma receita. Com onPriceChange, permite digitar o preço praticado. */
export function ChannelPriceTable({ unitCost, recipe, settings, onPriceChange }: {
  unitCost: number
  recipe: Pick<Recipe, 'margin_pct' | 'packaging_cost' | 'channel_prices'>
  settings: Settings
  onPriceChange?: (channelId: string, price: number | null) => void
}) {
  const rows = channelPrices(unitCost, recipe, settings)
  if (!rows.length) return <p className="muted small">Configure as taxas de delivery no Painel para ver o preço em cada app.</p>
  return (
    <div className="table-wrap">
      <table className="channel-table">
        <thead>
          <tr>
            <th>Canal</th>
            <th className="num">Custo da receita</th>
            <th className="num">Custo do canal</th>
            <th className="num">Custo total</th>
            <th className="num">Sugerido (+{pct(recipe.margin_pct || 0)})</th>
            {onPriceChange && <th className="num">Preço praticado</th>}
            <th className="num">Lucro/venda</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.channel.id}>
              <td>{r.channel.name}<div className="muted small">taxas {pct(r.feesPct)}</div></td>
              <td className="num">{money(unitCost)}</td>
              <td className="num">
                {money(r.channelCost)}
                <div className="muted small">{pct(r.feesPct)} de {money(r.basePrice)}</div>
              </td>
              <td className="num">{money(r.totalCost)}</td>
              <td className="num">
                <span className="strong accent">{money(r.suggestedPrice)}</span>
                <div className="muted small">arredondado {money(r.roundedPrice)}</div>
              </td>
              {onPriceChange && (
                <td className="num">
                  <input className="price-input" type="number" min="0" step="0.01" placeholder="—" aria-label={`Preço praticado no ${r.channel.name}`}
                    value={recipe.channel_prices?.[r.channel.id] ?? ''}
                    onChange={(e) => onPriceChange(r.channel.id, e.target.value === '' ? null : Number(e.target.value))} />
                  {r.minPrice != null && <div className="muted small">sem prejuízo a partir de {money(r.minPrice)}</div>}
                </td>
              )}
              <td className={`num ${r.profit != null && r.profit < 0 ? 'neg' : 'pos'}`}>
                <Profit r={r} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="muted small">
        Custo do canal: taxas do app sobre o preço sugerido da receita ({money(unitCost * (1 + (recipe.margin_pct || 0) / 100))}), mais embalagem e taxa fixa.
        Lucro/venda: o que sobra depois das taxas do app e dos custos, no preço praticado (ou no sugerido, quando não há preço praticado).
      </p>
    </div>
  )
}

function Profit({ r }: { r: ChannelPrice }) {
  if (r.profit == null) return <>—</>
  return (
    <>
      {money(r.profit)}
      <div className="small">{r.profitPct != null && pct(r.profitPct)}{r.currentPrice == null && ' · no sugerido'}</div>
    </>
  )
}
