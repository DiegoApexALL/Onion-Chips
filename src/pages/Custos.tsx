import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react'
import ConfirmButton from '../ConfirmButton'
import { money, pct } from '../lib/cost'
import { supabase } from '../lib/store'

export type TipoCusto = 'fixo' | 'variavel'

export interface Custo {
  id: string
  company_id: string
  tipo: TipoCusto
  descricao: string
  categoria: string
  valor: number
  unidade: 'reais' | 'percentual'
  periodicidade: 'mensal' | 'anual'
  vencimento_dia: number | null
  fornecedor: string | null
  observacao: string | null
  ativo: boolean
}

const CATEGORIAS: Record<TipoCusto, string[]> = {
  fixo: ['Aluguel', 'Salários e encargos', 'Pró-labore', 'Água, luz, gás e internet', 'Contador', 'Sistemas e assinaturas',
    'Impostos e taxas fixas', 'Seguros', 'Manutenção', 'Marketing', 'Empréstimos e financiamentos', 'Outros'],
  variavel: ['Taxa de cartão', 'Aplicativo de delivery', 'Impostos sobre venda', 'Embalagens', 'Comissões', 'Entrega / frete',
    'Insumos extras', 'Outros'],
}

const TEXTOS: Record<TipoCusto, { titulo: string; exemplo: string; vazio: string }> = {
  fixo: {
    titulo: 'Custos fixos',
    exemplo: 'Ex.: Aluguel da loja',
    vazio: 'Nenhum custo fixo cadastrado. Comece pelo aluguel, salários e contas de consumo.',
  },
  variavel: {
    titulo: 'Custos variáveis',
    exemplo: 'Ex.: Taxa da maquininha (crédito)',
    vazio: 'Nenhum custo variável cadastrado. Ex.: taxa de cartão, comissão do iFood, impostos do Simples, embalagens.',
  },
}

/** Valor do custo fixo convertido para o mês (anual ÷ 12). */
export const fixoMensal = (c: Custo) => (c.periodicidade === 'anual' ? Number(c.valor) / 12 : Number(c.valor))

export function resumoCustos(custos: Custo[]) {
  const ativos = custos.filter((c) => c.ativo)
  const fixos = ativos.filter((c) => c.tipo === 'fixo').reduce((s, c) => s + fixoMensal(c), 0)
  const varReais = ativos.filter((c) => c.tipo === 'variavel' && c.unidade === 'reais').reduce((s, c) => s + Number(c.valor), 0)
  const varPct = ativos.filter((c) => c.tipo === 'variavel' && c.unidade === 'percentual').reduce((s, c) => s + Number(c.valor), 0)
  // Faturamento que paga todos os custos: (fixos + variáveis em R$) / (1 - % variável)
  const equilibrio = varPct < 100 ? (fixos + varReais) / (1 - varPct / 100) : null
  return { fixos, varReais, varPct, equilibrio }
}

const vazio = (tipo: TipoCusto) => ({
  descricao: '',
  categoria: CATEGORIAS[tipo][0],
  valor: '',
  unidade: (tipo === 'variavel' ? 'percentual' : 'reais') as Custo['unidade'],
  periodicidade: 'mensal' as Custo['periodicidade'],
  vencimento_dia: '',
  fornecedor: '',
  observacao: '',
  ativo: true,
})

// Aceita "2.500,00", "2500,5" e "3.5"
const toNumber = (s: string) => {
  const t = s.trim().replace(/[R$\s%]/g, '')
  return t === '' ? NaN : Number(t.includes(',') ? t.replace(/\./g, '').replace(',', '.') : t)
}
const fmtInput = (n: number) => String(n).replace('.', ',')

export default function Custos({ tipo, companyId, companyName, faturamento, mesLabel, onError }: {
  tipo: TipoCusto
  companyId: string
  companyName: string
  faturamento: number
  mesLabel: string
  onError: (msg: string) => void
}) {
  const [custos, setCustos] = useState<Custo[]>([])
  const [form, setForm] = useState(() => vazio(tipo))
  const [editingId, setEditingId] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const texto = TEXTOS[tipo]

  const load = useCallback(async () => {
    const { data, error } = await supabase!.from('company_costs').select('*').eq('company_id', companyId)
      .order('categoria').order('descricao')
    if (error) {
      onError(/company_costs|schema cache|does not exist/i.test(error.message)
        ? 'A tabela de custos ainda não existe no banco. Rode o arquivo supabase/custos.sql no Supabase.'
        : error.message)
    } else setCustos((data ?? []) as Custo[])
    setLoaded(true)
  }, [companyId, onError])

  useEffect(() => {
    setLoaded(false)
    load()
  }, [load])

  useEffect(() => {
    setForm(vazio(tipo))
    setEditingId(null)
  }, [tipo, companyId])

  const resumo = useMemo(() => resumoCustos(custos), [custos])
  const lista = custos.filter((c) => c.tipo === tipo)
  const grupos = useMemo(() => {
    const g = new Map<string, Custo[]>()
    for (const c of lista) g.set(c.categoria, [...(g.get(c.categoria) ?? []), c])
    return [...g.entries()]
  }, [lista])

  async function submit(e: FormEvent) {
    e.preventDefault()
    const valor = toNumber(form.valor)
    if (!Number.isFinite(valor) || valor < 0) return onError('Valor inválido.')
    if (form.unidade === 'percentual' && valor > 100) return onError('O percentual não pode passar de 100%.')
    const dia = form.vencimento_dia ? Number(form.vencimento_dia) : null
    if (dia !== null && (!Number.isInteger(dia) || dia < 1 || dia > 31)) return onError('Dia de vencimento deve ser de 1 a 31.')
    setBusy(true)
    try {
      const row = {
        company_id: companyId,
        tipo,
        descricao: form.descricao.trim(),
        categoria: form.categoria.trim() || 'Outros',
        valor,
        unidade: tipo === 'fixo' ? 'reais' : form.unidade,
        periodicidade: tipo === 'fixo' ? form.periodicidade : 'mensal',
        vencimento_dia: dia,
        fornecedor: form.fornecedor.trim() || null,
        observacao: form.observacao.trim() || null,
        ativo: form.ativo,
        updated_at: new Date().toISOString(),
      }
      const { error } = editingId
        ? await supabase!.from('company_costs').update(row).eq('id', editingId)
        : await supabase!.from('company_costs').insert(row)
      if (error) throw error
      setForm(vazio(tipo))
      setEditingId(null)
      await load()
    } catch (err) {
      onError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  function edit(c: Custo) {
    setEditingId(c.id)
    setForm({
      descricao: c.descricao,
      categoria: c.categoria,
      valor: fmtInput(Number(c.valor)),
      unidade: c.unidade,
      periodicidade: c.periodicidade,
      vencimento_dia: c.vencimento_dia ? String(c.vencimento_dia) : '',
      fornecedor: c.fornecedor ?? '',
      observacao: c.observacao ?? '',
      ativo: c.ativo,
    })
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }

  async function toggle(c: Custo) {
    const { error } = await supabase!.from('company_costs').update({ ativo: !c.ativo, updated_at: new Date().toISOString() }).eq('id', c.id)
    if (error) onError(error.message)
    await load()
  }

  async function remove(c: Custo) {
    const { error } = await supabase!.from('company_costs').delete().eq('id', c.id)
    if (error) onError(error.message)
    await load()
  }

  const valorTexto = (c: Custo) =>
    c.unidade === 'percentual' ? `${pct(Number(c.valor))} do faturamento`
      : c.periodicidade === 'anual' ? `${money(Number(c.valor))}/ano (${money(fixoMensal(c))}/mês)`
        : `${money(Number(c.valor))}/mês`

  const varEstimado = resumo.varReais + (faturamento * resumo.varPct) / 100

  return (
    <>
      <section className="card">
        <h2>Resumo de {companyName}</h2>
        <div className="cost-summary">
          <div>
            <div className="muted small">Custos fixos por mês</div>
            <div className="stat-value">{money(resumo.fixos)}</div>
          </div>
          <div>
            <div className="muted small">Custos variáveis</div>
            <div className="stat-value">{pct(resumo.varPct)}</div>
            <div className="small muted">do faturamento{resumo.varReais > 0 ? ` + ${money(resumo.varReais)}/mês` : ''}</div>
          </div>
          <div>
            <div className="muted small">Ponto de equilíbrio</div>
            <div className="stat-value">{resumo.equilibrio === null ? '—' : money(resumo.equilibrio)}</div>
            <div className="small muted">faturamento mínimo por mês para pagar todos os custos</div>
          </div>
          <div>
            <div className="muted small">Vendas (NFC-e) em {mesLabel}</div>
            <div className="stat-value">{money(faturamento)}</div>
            <div className="small muted">
              {faturamento > 0
                ? `Custos estimados: ${money(resumo.fixos + varEstimado)} · sobra ${money(faturamento - resumo.fixos - varEstimado)}`
                : 'Sem vendas registradas ainda neste mês'}
            </div>
          </div>
        </div>
        {resumo.equilibrio !== null && faturamento > 0 && (
          <div className={`small ${faturamento >= resumo.equilibrio ? 'tone-ok' : 'tone-high'}`}>
            {faturamento >= resumo.equilibrio
              ? `As vendas do mês já passaram do ponto de equilíbrio (${pct((faturamento / resumo.equilibrio) * 100)}).`
              : `Faltam ${money(resumo.equilibrio - faturamento)} em vendas para cobrir os custos do mês.`}
          </div>
        )}
      </section>

      <form className="card form-grid" onSubmit={submit}>
        <h2 className="full">{editingId ? `Editar custo ${tipo === 'fixo' ? 'fixo' : 'variável'}` : `Novo custo ${tipo === 'fixo' ? 'fixo' : 'variável'}`}</h2>
        <label className="full">
          Descrição
          <input required placeholder={texto.exemplo} value={form.descricao} onChange={(e) => setForm({ ...form, descricao: e.target.value })} />
        </label>
        <label>
          Categoria
          <input list={`cat-${tipo}`} value={form.categoria} onChange={(e) => setForm({ ...form, categoria: e.target.value })} />
          <datalist id={`cat-${tipo}`}>
            {CATEGORIAS[tipo].map((c) => <option key={c} value={c} />)}
          </datalist>
        </label>
        {tipo === 'variavel' ? (
          <label>
            Como é cobrado
            <select value={form.unidade} onChange={(e) => setForm({ ...form, unidade: e.target.value as Custo['unidade'] })}>
              <option value="percentual">% sobre o faturamento</option>
              <option value="reais">R$ por mês (média)</option>
            </select>
          </label>
        ) : (
          <label>
            Periodicidade
            <select value={form.periodicidade} onChange={(e) => setForm({ ...form, periodicidade: e.target.value as Custo['periodicidade'] })}>
              <option value="mensal">Mensal</option>
              <option value="anual">Anual (entra ÷ 12 no mês)</option>
            </select>
          </label>
        )}
        <label>
          {form.unidade === 'percentual' && tipo === 'variavel' ? 'Percentual (%)' : 'Valor (R$)'}
          <input required inputMode="decimal" placeholder={form.unidade === 'percentual' && tipo === 'variavel' ? 'Ex.: 3,5' : 'Ex.: 2.500,00'}
            value={form.valor} onChange={(e) => setForm({ ...form, valor: e.target.value })} />
        </label>
        <label>
          Dia de vencimento <span className="muted">(opcional)</span>
          <input inputMode="numeric" placeholder="1 a 31" value={form.vencimento_dia}
            onChange={(e) => setForm({ ...form, vencimento_dia: e.target.value.replace(/\D/g, '').slice(0, 2) })} />
        </label>
        <label className="full">
          Fornecedor / quem recebe <span className="muted">(opcional)</span>
          <input placeholder="Ex.: Imobiliária Silva, Stone, iFood" value={form.fornecedor} onChange={(e) => setForm({ ...form, fornecedor: e.target.value })} />
        </label>
        <label className="full">
          Observação <span className="muted">(opcional)</span>
          <input placeholder="Ex.: reajuste pelo IGP-M em março" value={form.observacao} onChange={(e) => setForm({ ...form, observacao: e.target.value })} />
        </label>
        <label className="check full">
          <input type="checkbox" checked={form.ativo} onChange={(e) => setForm({ ...form, ativo: e.target.checked })} />
          Ativo (entra nas contas do resumo)
        </label>
        <div className="full actions">
          {editingId && (
            <button type="button" className="ghost" onClick={() => { setEditingId(null); setForm(vazio(tipo)) }}>Cancelar</button>
          )}
          <button className="primary" disabled={busy}>{editingId ? 'Salvar' : 'Adicionar'}</button>
        </div>
      </form>

      <section className="card">
        <div className="row-between">
          <h2>{texto.titulo} ({lista.length})</h2>
          {tipo === 'fixo' && lista.length > 0 && <span className="strong">{money(resumo.fixos)}/mês</span>}
        </div>
        {loaded && lista.length === 0 && <p className="muted">{texto.vazio}</p>}
        {grupos.map(([cat, itens]) => (
          <div key={cat} className="cost-group">
            <div className="muted small strong">{cat}</div>
            <ul className="note-list cost-list">
              {itens.map((c) => (
                <li key={c.id} className={c.ativo ? '' : 'muted'}>
                  <div>
                    <div className="strong">{c.descricao}{!c.ativo && <span className="chip chip-low"> inativo</span>}</div>
                    <div className="small muted">
                      {[c.fornecedor, c.vencimento_dia ? `vence dia ${c.vencimento_dia}` : null, c.observacao].filter(Boolean).join(' · ')}
                    </div>
                  </div>
                  <div className="num">{valorTexto(c)}</div>
                  <div className="row-actions cost-actions">
                    <button className="ghost small" onClick={() => edit(c)}>Editar</button>
                    <button className="ghost small" onClick={() => toggle(c)}>{c.ativo ? 'Desativar' : 'Ativar'}</button>
                    <ConfirmButton onConfirm={() => remove(c)} title="Apaga este custo" />
                  </div>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </section>
    </>
  )
}
