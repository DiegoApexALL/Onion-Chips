import { useCallback, useEffect, useMemo, useState } from 'react'
import { money, pct } from '../lib/cost'
import { supabase } from '../lib/store'
import { fixoMensal, type Custo } from './Custos'

interface Vendas { competencia: string; valor: number; baixadas: number; total_chaves: number }
interface Compra { competencia: string | null; valor: number | null; situacao: string; emit_nome: string | null }

interface Mes {
  mes: string
  vendas: number
  vendasParcial: boolean
  compras: number
  variaveis: number
  fixos: number
  resultado: number
  margem: number | null
  fornecedores: [string, number][]
}

const mesLabel = (m: string, curto = false) => {
  const [y, mo] = m.split('-').map(Number)
  const nome = new Date(y, mo - 1, 1).toLocaleDateString('pt-BR', { month: curto ? 'short' : 'long' }).replace('.', '')
  const cap = nome.charAt(0).toUpperCase() + nome.slice(1)
  return curto ? `${cap}/${String(y).slice(2)}` : `${cap} de ${y}`
}

/** R$ curto para os gráficos: "−9,5 mil" */
const moneyCurto = (n: number) =>
  Math.abs(n) >= 1000 ? `${n < 0 ? '−' : ''}${(Math.abs(n) / 1000).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} mil` : money(n)

function ultimosMeses(atual: string, n: number) {
  const [y, m] = atual.split('-').map(Number)
  return Array.from({ length: n }, (_, i) => {
    const d = new Date(y, m - 1 - i, 1)
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
  })
}

/** Dia de hoje e total de dias do mês, no horário de Brasília */
function progressoMes(atual: string) {
  const hoje = Number(new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo', day: '2-digit' }).format(new Date()))
  const [y, m] = atual.split('-').map(Number)
  return { hoje, dias: new Date(y, m, 0).getDate() }
}

export default function Resultado({ companyId, companyName, mesAtual, onError }: {
  companyId: string
  companyName: string
  mesAtual: string
  onError: (msg: string) => void
}) {
  const [vendas, setVendas] = useState<Vendas[]>([])
  const [compras, setCompras] = useState<Compra[]>([])
  const [custos, setCustos] = useState<Custo[]>([])
  const [loaded, setLoaded] = useState(false)
  const [sel, setSel] = useState(mesAtual)

  const load = useCallback(async () => {
    const [a, b, c] = await Promise.all([
      supabase!.from('nfce_resumo').select('competencia, valor, baixadas, total_chaves').eq('company_id', companyId),
      supabase!.from('nfe_docs').select('competencia, valor, situacao, emit_nome').eq('company_id', companyId),
      supabase!.from('company_costs').select('*').eq('company_id', companyId),
    ])
    const err = a.error ?? b.error ?? c.error
    if (err) onError(err.message)
    else {
      setVendas((a.data ?? []).map((v) => ({ ...v, valor: Number(v.valor), baixadas: Number(v.baixadas), total_chaves: Number(v.total_chaves) })) as Vendas[])
      setCompras((b.data ?? []) as Compra[])
      setCustos((c.data ?? []) as Custo[])
    }
    setLoaded(true)
  }, [companyId, onError])

  useEffect(() => {
    setLoaded(false)
    load()
  }, [load])

  const meses = useMemo<Mes[]>(() => {
    const ativos = custos.filter((c) => c.ativo)
    const fixos = ativos.filter((c) => c.tipo === 'fixo').reduce((s, c) => s + fixoMensal(c), 0)
    const varPct = ativos.filter((c) => c.tipo === 'variavel' && c.unidade === 'percentual').reduce((s, c) => s + Number(c.valor), 0)
    const varReais = ativos.filter((c) => c.tipo === 'variavel' && c.unidade === 'reais').reduce((s, c) => s + Number(c.valor), 0)
    // Só os meses com vendas baixadas (antes disso não há como calcular o resultado)
    return ultimosMeses(mesAtual, 6).filter((mes) => mes === mesAtual || vendas.some((x) => x.competencia === mes)).map((mes) => {
      const v = vendas.find((x) => x.competencia === mes)
      const notas = compras.filter((n) => n.competencia === mes && n.situacao === 'autorizada')
      const forn = new Map<string, number>()
      for (const n of notas) forn.set(n.emit_nome ?? 'Sem nome', (forn.get(n.emit_nome ?? 'Sem nome') ?? 0) + Number(n.valor ?? 0))
      const vendasMes = v?.valor ?? 0
      const comprasMes = notas.reduce((s, n) => s + Number(n.valor ?? 0), 0)
      const variaveis = (vendasMes * varPct) / 100 + varReais
      const resultado = vendasMes - comprasMes - variaveis - fixos
      return {
        mes,
        vendas: vendasMes,
        vendasParcial: !!v && v.baixadas < v.total_chaves,
        compras: comprasMes,
        variaveis,
        fixos,
        resultado,
        margem: vendasMes > 0 ? (resultado / vendasMes) * 100 : null,
        fornecedores: [...forn.entries()].sort((x, y) => y[1] - x[1]).slice(0, 5),
      }
    })
  }, [vendas, compras, custos, mesAtual])

  const m = meses.find((x) => x.mes === sel) ?? meses[0]
  const emAndamento = m.mes === mesAtual
  const { hoje, dias } = progressoMes(mesAtual)
  const fator = emAndamento && hoje > 0 ? dias / hoje : 1
  const projVendas = m.vendas * fator
  const projCompras = m.compras * fator
  const ativos = custos.filter((c) => c.ativo)
  const varPct = ativos.filter((c) => c.tipo === 'variavel' && c.unidade === 'percentual').reduce((s, c) => s + Number(c.valor), 0)
  const varReais = ativos.filter((c) => c.tipo === 'variavel' && c.unidade === 'reais').reduce((s, c) => s + Number(c.valor), 0)
  const projResultado = projVendas - projCompras - ((projVendas * varPct) / 100 + varReais) - m.fixos
  const semCustos = custos.length === 0
  const max = Math.max(1, ...meses.map((x) => Math.max(x.vendas, x.compras + x.variaveis + x.fixos)))

  const linha = (rotulo: string, valor: number, opts: { neg?: boolean; forte?: boolean; obs?: string } = {}) => (
    <li className={opts.forte ? 'dre-total' : ''}>
      <div>
        <div className={opts.forte ? 'strong' : ''}>{rotulo}</div>
        {opts.obs && <div className="small muted">{opts.obs}</div>}
      </div>
      <div className={`num ${opts.forte ? 'strong' : ''} ${opts.forte ? (valor >= 0 ? 'tone-ok' : 'tone-high') : ''}`}>
        {opts.neg ? `− ${money(valor)}` : money(valor)}
      </div>
    </li>
  )

  if (!loaded) return <p className="card muted">Carregando…</p>

  return (
    <>
      <section className="card">
        <div className="row-between">
          <h2>Resultado de {companyName}</h2>
          <select className="narrow-select" value={m.mes} onChange={(e) => setSel(e.target.value)}>
            {meses.map((x) => <option key={x.mes} value={x.mes}>{mesLabel(x.mes)}{x.mes === mesAtual ? ' (em andamento)' : ''}</option>)}
          </select>
        </div>
        {semCustos && (
          <div className="hint">Cadastre os custos fixos e variáveis nas abas ao lado para o resultado ficar completo.</div>
        )}
        <ul className="note-list dre">
          {linha('Vendas (NFC-e)', m.vendas, {
            obs: m.vendasParcial ? 'Parte das notas do mês ainda está sendo baixada da SEFAZ' : undefined,
          })}
          {linha('Custos variáveis', m.variaveis, { neg: true, obs: `${pct(varPct)} das vendas${varReais ? ` + ${money(varReais)}` : ''}` })}
          {linha('Compras (notas recebidas)', m.compras, { neg: true, obs: 'Total das NF-e de compra do mês, usado como custo das mercadorias' })}
          {linha('Margem de contribuição', m.vendas - m.variaveis - m.compras, {
            obs: m.vendas > 0 ? `${pct(((m.vendas - m.variaveis - m.compras) / m.vendas) * 100)} das vendas` : undefined,
          })}
          {linha('Custos fixos', m.fixos, { neg: true })}
          {linha(emAndamento ? 'Resultado até hoje' : 'Resultado do mês', m.resultado, {
            forte: true,
            obs: m.margem !== null ? `Margem de ${pct(m.margem)}` : 'Sem vendas registradas',
          })}
        </ul>
        {emAndamento && m.vendas > 0 && (
          <div className={`hint ${projResultado >= 0 ? '' : 'hint-alert'}`}>
            <b>Projeção para o mês inteiro</b> (no ritmo dos primeiros {hoje} de {dias} dias): vendas de {money(projVendas)},
            compras de {money(projCompras)} e resultado de <b className={projResultado >= 0 ? 'tone-ok' : 'tone-high'}>{money(projResultado)}</b>.
          </div>
        )}
        {m.fornecedores.length > 0 && (
          <div className="dre-forn">
            <div className="muted small strong">Maiores fornecedores do mês</div>
            {m.fornecedores.map(([nome, v]) => (
              <div key={nome} className="small row-between"><span>{nome}</span><span className="num">{money(v)}</span></div>
            ))}
          </div>
        )}
        <p className="muted small">
          Os custos fixos e variáveis usados são os cadastrados hoje. As compras entram no mês da emissão da nota.
        </p>
      </section>

      <section className="card">
        <h2>Mês a mês</h2>
        <div className="dre-bars" style={{ gridTemplateColumns: `repeat(${meses.length}, minmax(0, 1fr))` }}>
          {[...meses].reverse().map((x) => (
            <button type="button" key={x.mes} className={`dre-bar${x.mes === m.mes ? ' on' : ''}`} onClick={() => setSel(x.mes)}
              title={`${mesLabel(x.mes)}: resultado ${money(x.resultado)}`}>
              <div className="dre-cols">
                <span className="bar-vendas" style={{ height: `${(x.vendas / max) * 100}%` }} />
                <span className="bar-custos" style={{ height: `${((x.compras + x.variaveis + x.fixos) / max) * 100}%` }} />
              </div>
              <span className="small">{mesLabel(x.mes, true)}</span>
              <span className={`small strong ${x.resultado >= 0 ? 'tone-ok' : 'tone-high'}`}>{moneyCurto(x.resultado)}</span>
            </button>
          ))}
        </div>
        <div className="small muted dre-legend"><span className="sw bar-vendas" /> Vendas <span className="sw bar-custos" /> Custos totais</div>
        <div className="table-wrap">
          <table className="dre-table">
            <thead>
              <tr><th>Mês</th><th className="num">Vendas</th><th className="num">Compras</th><th className="num">Variáveis</th><th className="num">Fixos</th><th className="num">Resultado</th></tr>
            </thead>
            <tbody>
              {meses.map((x) => (
                <tr key={x.mes}>
                  <td>{mesLabel(x.mes, true)}{x.mes === mesAtual ? '*' : ''}</td>
                  <td className="num">{money(x.vendas)}</td>
                  <td className="num">{money(x.compras)}</td>
                  <td className="num">{money(x.variaveis)}</td>
                  <td className="num">{money(x.fixos)}</td>
                  <td className={`num strong ${x.resultado >= 0 ? 'tone-ok' : 'tone-high'}`}>{money(x.resultado)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="muted small">* mês em andamento (até hoje)</p>
      </section>
    </>
  )
}
