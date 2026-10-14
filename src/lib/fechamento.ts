// Fechamento de caixa: modelo de texto (gerado pela Meta AI no WhatsApp), leitura e conferência.
// Tudo aqui é sem IA: o app só lê o texto padronizado.

export interface Maquininha { nome: string; debito: number; credito: number; pix: number }
export interface Delivery { canal: string; pedidos: number; valor: number }
export interface Despesa { descricao: string; valor: number }
export interface Pagamentos { dinheiro: number; debito: number; credito: number; outros: number; pix: number }

export interface Fechamento {
  unidade_texto: string
  cnpj: string
  data: string // AAAA-MM-DD
  abertura_at: string | null // AAAA-MM-DDThh:mm
  fechamento_at: string | null
  responsavel: string
  vendas_qtd: number
  vendas_total: number
  valor_abertura: number
  sistema: Pagamentos
  contado: Pagamentos
  maquininhas: Maquininha[]
  delivery: Delivery[]
  despesas: Despesa[]
  repasse: number
  troco: number
  observacoes: string
}

export const emptyPagamentos = (): Pagamentos => ({ dinheiro: 0, debito: 0, credito: 0, outros: 0, pix: 0 })

export function emptyFechamento(): Fechamento {
  return {
    unidade_texto: '', cnpj: '', data: '', abertura_at: null, fechamento_at: null, responsavel: '',
    vendas_qtd: 0, vendas_total: 0, valor_abertura: 0,
    sistema: emptyPagamentos(), contado: emptyPagamentos(),
    maquininhas: [], delivery: [], despesas: [], repasse: 0, troco: 0, observacoes: '',
  }
}

/** Pedido para colar na Meta AI do WhatsApp, junto com as fotos do fechamento. */
export const PROMPT_META_AI = `Leia TODAS as fotos de fechamento de caixa que mandei acima e responda SOMENTE com o texto abaixo preenchido, sem comentários.
Regras: valores em reais com vírgula (ex.: 1033,80), sem "R$"; se um valor não aparecer, escreva 0; não invente números; datas no formato DD/MM/AAAA e horas HH:MM.
- UNIDADE e CNPJ: o nome da loja e o CNPJ que aparecem nos comprovantes.
- SISTEMA = "Saldo apurado pelo sistema" do PDV; CONTADO = "Saldo apurado pelo responsável". Em DINHEIRO use só o dinheiro de vendas (sem a abertura).
- MAQUININHA: uma linha por maquininha (SumUp, PagBank, Stone, Cielo etc.) com o débito, crédito e Pix do resumo do dia.
- DELIVERY: some os pedidos de cada app (iFood, Keeta, 99Food, ByFood etc.) do recibo dos pedidos: quantidade de pedidos e valor total.
- DESPESA: uma linha por despesa anotada na folha (descrição; valor). Se não houver, escreva DESPESA: nenhuma; 0.
- REPASSE e TROCO: da folha de fechamento.

#FECHAMENTO ONION COST
UNIDADE:
CNPJ:
DATA:
ABERTURA: DD/MM/AAAA HH:MM
FECHAMENTO: DD/MM/AAAA HH:MM
RESPONSAVEL:
VENDAS QTD:
VENDAS TOTAL:
VALOR ABERTURA:
SISTEMA DINHEIRO:
SISTEMA DEBITO:
SISTEMA CREDITO:
SISTEMA OUTROS:
SISTEMA PIX:
CONTADO DINHEIRO:
CONTADO DEBITO:
CONTADO CREDITO:
CONTADO OUTROS:
CONTADO PIX:
MAQUININHA <NOME>: DEBITO 0; CREDITO 0; PIX 0
DELIVERY <APP>: 0 PEDIDOS; 0
DESPESA: <descrição>; 0
REPASSE:
TROCO:
#FIM`

// ---------------- leitura ----------------

/** Remove acentos, deixa em maiúsculas e tira marcas de markdown que a IA às vezes coloca. */
export function norm(s: string): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[*_`]/g, '').toUpperCase().trim()
}

/** Aceita 1.033,80 / 1033,80 / 1033.80 / R$ 1.033,80 / -9,00. */
export function money(s: string | undefined | null): number {
  if (!s) return 0
  const m = String(s).replace(/R\$/gi, '').replace(/\s/g, '').match(/-?[\d.,]+/)
  if (!m) return 0
  let t = m[0]
  if (t.includes(',')) t = t.replace(/\./g, '').replace(',', '.')
  else if ((t.match(/\./g) ?? []).length > 1 || /\.\d{3}$/.test(t)) t = t.replace(/\./g, '')
  const n = Number(t)
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0
}

function int(s: string): number {
  const m = s.match(/\d+/)
  return m ? Number(m[0]) : 0
}

/** DD/MM/AAAA (ou DD/MM/AA) → AAAA-MM-DD. */
export function isoDate(s: string): string {
  const m = s.match(/(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})/)
  if (!m) return ''
  const y = m[3].length === 2 ? `20${m[3]}` : m[3]
  return `${y}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`
}

function isoDateTime(s: string): string | null {
  const d = isoDate(s)
  const t = s.match(/(\d{1,2}):(\d{2})/)
  return d && t ? `${d}T${t[1].padStart(2, '0')}:${t[2]}` : null
}

/** Valores "DEBITO 372,60; CREDITO 939,75; PIX 579,36" → mapa. */
function pairs(s: string): Record<string, number> {
  const out: Record<string, number> = {}
  for (const part of s.split(/[;|]/)) {
    const m = part.trim().match(/^([A-Z ]+?)\s*[:=]?\s*(-?[\d.,]+)$/)
    if (m) out[m[1].trim()] = money(m[2])
  }
  return out
}

export interface ParseResult { fechamento: Fechamento; avisos: string[] }

export function parseFechamento(texto: string): ParseResult {
  const f = emptyFechamento()
  const avisos: string[] = []
  let reconhecidas = 0
  const lines = texto.split(/\r?\n/)
  for (const raw of lines) {
    const line = raw.replace(/^[\s>*\-•]+/, '')
    const idx = line.indexOf(':')
    if (idx < 0) continue
    const key = norm(line.slice(0, idx)).replace(/\s+/g, ' ')
    const value = line.slice(idx + 1).replace(/[*_`]/g, '').trim()
    const v = norm(value)
    reconhecidas++
    if (key === 'UNIDADE') f.unidade_texto = value
    else if (key === 'CNPJ') f.cnpj = value.replace(/\D/g, '')
    else if (key === 'DATA') f.data = isoDate(value)
    else if (key === 'ABERTURA') f.abertura_at = isoDateTime(value)
    else if (key === 'FECHAMENTO') f.fechamento_at = isoDateTime(value)
    else if (key === 'RESPONSAVEL') f.responsavel = value
    else if (key === 'VENDAS QTD') f.vendas_qtd = int(value)
    else if (key === 'VENDAS TOTAL') f.vendas_total = money(value)
    else if (key === 'VALOR ABERTURA') f.valor_abertura = money(value)
    else if (key === 'REPASSE') f.repasse = money(value)
    else if (key === 'TROCO') f.troco = money(value)
    else if (key === 'OBSERVACOES' || key === 'OBS') f.observacoes = value
    else if (/^(SISTEMA|CONTADO) (DINHEIRO|DEBITO|CREDITO|OUTROS|PIX)$/.test(key)) {
      const [lado, forma] = key.split(' ') as ['SISTEMA' | 'CONTADO', string]
      const alvo = lado === 'SISTEMA' ? f.sistema : f.contado
      alvo[forma.toLowerCase() as keyof Pagamentos] = money(value)
    } else if (key.startsWith('MAQUININHA')) {
      const nome = key.replace(/^MAQUININHA\s*/, '').trim() || 'MAQUININHA'
      const p = pairs(v)
      f.maquininhas.push({ nome, debito: p.DEBITO ?? 0, credito: (p.CREDITO ?? 0) + (p['CREDITO A VISTA'] ?? 0) + (p['CREDITO PARC'] ?? 0), pix: p.PIX ?? 0 })
    } else if (key.startsWith('DELIVERY')) {
      const canal = key.replace(/^DELIVERY\s*/, '').trim() || 'DELIVERY'
      const partes = v.split(/[;|]/)
      const pedidos = partes.length > 1 ? int(partes[0]) : 0
      const valor = money(partes[partes.length - 1])
      if (pedidos || valor) f.delivery.push({ canal, pedidos, valor })
    } else if (key.startsWith('DESPESA')) {
      const [desc, val] = value.split(/;(?=[^;]*$)/)
      const valor = money(val ?? desc)
      if (valor) f.despesas.push({ descricao: (val ? desc : '').trim() || 'Despesa', valor })
    } else {
      reconhecidas--
    }
  }
  if (!reconhecidas) avisos.push('Não encontrei nenhum campo do modelo. Confira se colou o texto da Meta AI inteiro.')
  if (!f.data) avisos.push('Data do fechamento não encontrada.')
  if (!f.vendas_total) avisos.push('Total de vendas não encontrado.')
  return { fechamento: f, avisos }
}

// ---------------- unidade ----------------

export interface Unidade { id: string; nome: string; cidade: string; apelidos: string | null; company_id: string | null; cnpj?: string | null }

/** Acha a unidade pelo CNPJ (raiz) ou por nome/apelido/cidade que apareça no texto. */
export function matchUnidade(unidades: Unidade[], f: Fechamento, textoCompleto = ''): Unidade | null {
  const raiz = f.cnpj.slice(0, 8)
  if (raiz.length === 8) {
    const byCnpj = unidades.find((u) => (u.cnpj ?? '').slice(0, 8) === raiz || norm(u.apelidos ?? '').replace(/\D/g, ' ').split(/\s+/).includes(raiz))
    if (byCnpj) return byCnpj
  }
  const alvo = norm(`${f.unidade_texto} ${textoCompleto}`)
  let best: Unidade | null = null
  let score = 0
  for (const u of unidades) {
    const termos = [u.nome, u.cidade, ...(u.apelidos ?? '').split(',')].map((t) => norm(t)).filter((t) => t.length >= 3)
    const s = termos.filter((t) => alvo.includes(t)).reduce((a, t) => a + t.length, 0)
    if (s > score) { score = s; best = u }
  }
  return best
}

// ---------------- conferência ----------------

export interface Linha { item: string; esperado: number; conferido: number; diferenca: number; nota?: string }

const r2 = (n: number) => Math.round(n * 100) / 100
export const somaPag = (p: Pagamentos) => r2(p.dinheiro + p.debito + p.credito + p.outros + p.pix)
export const somaMaq = (f: Fechamento, k: 'debito' | 'credito' | 'pix') => r2(f.maquininhas.reduce((s, m) => s + m[k], 0))

export function conferencia(f: Fechamento): Linha[] {
  const l = (item: string, esperado: number, conferido: number, nota?: string): Linha =>
    ({ item, esperado: r2(esperado), conferido: r2(conferido), diferenca: r2(conferido - esperado), nota })
  const out: Linha[] = [
    l('Dinheiro (sistema × contado)', f.sistema.dinheiro, f.contado.dinheiro),
    l('Débito (sistema × contado)', f.sistema.debito, f.contado.debito),
    l('Crédito (sistema × contado)', f.sistema.credito, f.contado.credito),
    l('Pix (sistema × contado)', f.sistema.pix, f.contado.pix),
    l('Outros/apps (sistema × contado)', f.sistema.outros, f.contado.outros),
  ]
  if (f.maquininhas.length) {
    out.push(
      l('Débito (contado × maquininhas)', f.contado.debito, somaMaq(f, 'debito')),
      l('Crédito (contado × maquininhas)', f.contado.credito, somaMaq(f, 'credito')),
      l('Pix (contado × maquininhas)', f.contado.pix, somaMaq(f, 'pix')),
    )
  }
  out.push(l('Vendas × formas de pagamento (PDV)', f.vendas_total, somaPag(f.sistema), 'diferença dentro do próprio sistema'))
  if (f.repasse || f.troco) {
    const gaveta = f.valor_abertura + f.contado.dinheiro
    const saida = f.repasse + f.troco + f.despesas.reduce((s, d) => s + d.valor, 0)
    out.push(l('Gaveta (abertura + dinheiro × repasse + troco + despesas)', gaveta, saida))
  }
  return out
}

export const totalDelivery = (f: Fechamento) => r2(f.delivery.reduce((s, d) => s + d.valor, 0))
export const totalDespesas = (f: Fechamento) => r2(f.despesas.reduce((s, d) => s + d.valor, 0))
/** Diferença geral contado − sistema (positivo = sobra). */
export const quebra = (f: Fechamento) => r2(somaPag(f.contado) - somaPag(f.sistema))
