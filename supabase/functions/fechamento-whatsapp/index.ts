// Edge Function "fechamento-whatsapp"
// O robô do WhatsApp (WAHA) chama esta função a cada mensagem que chega no grupo.
// Se a mensagem for um "#FECHAMENTO ONION COST", ela lê os campos, descobre a loja,
// salva em cash_closings (substitui se já existir a mesma loja + data) e responde no grupo.
//
// URL do webhook:  https://<projeto>.supabase.co/functions/v1/fechamento-whatsapp?token=<whatsapp_webhook_token>
// Teste sem salvar: adicione &dry=1 e mande { "texto": "..." } no corpo.
//
// Configuração (tabela app_secrets):
//   whatsapp_webhook_token  -> obrigatório, protege a URL
//   waha_url                -> ex.: http://meu-servidor:3000  (para o robô responder no grupo)
//   waha_api_key            -> a WAHA_API_KEY do robô
//   waha_session            -> opcional, padrão "default"
//   whatsapp_group_ids      -> opcional, ids de grupo aceitos separados por vírgula (vazio = qualquer grupo)
import { createClient } from 'npm:@supabase/supabase-js@2'

const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
  auth: { persistSession: false },
})
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

// ---------- utilidades ----------
const norm = (s: string) =>
  s.normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().replace(/\s+/g, ' ').trim()
const digits = (s: string) => s.replace(/\D/g, '')

function num(raw: string | undefined): number | null {
  if (raw == null) return null
  let s = raw.replace(/R\$|\s/gi, '')
  const m = s.match(/-?[\d.,]+/)
  if (!m) return null
  s = m[0]
  if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.') // 1.234,56
  else if ((s.match(/\./g) ?? []).length > 1) s = s.replace(/\./g, '') // 1.234.567
  const n = Number(s)
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : null
}
function data(raw: string | undefined): string | null {
  const m = raw?.match(/(\d{1,2})\/(\d{1,2})\/(\d{2,4})/)
  if (!m) return null
  const y = m[3].length === 2 ? '20' + m[3] : m[3]
  return `${y}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`
}
function dataHora(raw: string | undefined): string | null {
  const d = data(raw)
  const h = raw?.match(/(\d{1,2}):(\d{2})/)
  if (!d) return null
  return `${d} ${h ? `${h[1].padStart(2, '0')}:${h[2]}` : '00:00'}:00`
}
const brl = (n: number) => n.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const sinal = (n: number) => (n > 0 ? '+' : n < 0 ? '−' : '') + brl(Math.abs(n))
const brData = (iso: string) => iso.split('-').reverse().join('/')

// ---------- leitura do texto ----------
type Pag = { dinheiro: number; debito: number; credito: number; outros: number; pix: number }
const FORMAS: (keyof Pag)[] = ['dinheiro', 'debito', 'credito', 'outros', 'pix']

export function lerFechamento(texto: string) {
  const linhas = texto
    .replace(/\r/g, '')
    .split('\n')
    .map((l) => l.replace(/[*_~]/g, '').trim()) // tira negrito/itálico do WhatsApp
    .filter(Boolean)

  const campos: Record<string, string> = {}
  const sistema: Partial<Pag> = {}
  const contado: Partial<Pag> = {}
  const maquininhas: { nome: string; debito: number; credito: number; pix: number }[] = []
  const delivery: { canal: string; pedidos: number; valor: number }[] = []
  const despesas: { descricao: string; valor: number }[] = []

  for (const linha of linhas) {
    const i = linha.indexOf(':')
    if (i < 0) continue
    const chave = norm(linha.slice(0, i))
    const valor = linha.slice(i + 1).trim()

    const sc = chave.match(/^(SISTEMA|CONTADO) (DINHEIRO|DEBITO|CREDITO|OUTROS|PIX)$/)
    if (sc) {
      const alvo = sc[1] === 'SISTEMA' ? sistema : contado
      alvo[sc[2].toLowerCase() as keyof Pag] = num(valor) ?? 0
      continue
    }
    if (chave.startsWith('MAQUININHA')) {
      const nome = linha.slice(0, i).replace(/^\s*maquininha\s*/i, '').trim() || 'MAQUININHA'
      const parte = (k: string) => num(norm(valor).match(new RegExp(`${k}\\s*([\\d.,]+)`))?.[1]) ?? 0
      maquininhas.push({ nome, debito: parte('DEBITO'), credito: parte('CREDITO'), pix: parte('PIX') })
      continue
    }
    if (chave.startsWith('DELIVERY')) {
      const canal = linha.slice(0, i).replace(/^\s*delivery\s*/i, '').trim().toUpperCase() || 'OUTROS'
      const [a, b] = valor.split(';')
      const pedidos = b !== undefined ? Number(digits(a)) || 0 : 0
      const v = num(b !== undefined ? b : a) ?? 0
      if (pedidos || v) delivery.push({ canal, pedidos, valor: v })
      continue
    }
    if (chave.startsWith('DESPESA')) {
      const partes = valor.split(';')
      const v = num(partes.length > 1 ? partes[partes.length - 1] : valor) ?? 0
      const descricao = (partes.length > 1 ? partes.slice(0, -1).join(';') : '').trim()
      if (v > 0) despesas.push({ descricao: descricao || 'Despesa', valor: v })
      continue
    }
    campos[chave] = valor
  }

  const completa = (p: Partial<Pag>) => Object.fromEntries(FORMAS.map((f) => [f, p[f] ?? 0])) as Pag

  return {
    unidade: campos['UNIDADE'] ?? '',
    cnpj: campos['CNPJ'] ?? '',
    data: data(campos['DATA']) ?? data(campos['FECHAMENTO']) ?? null,
    abertura_at: dataHora(campos['ABERTURA']),
    fechamento_at: dataHora(campos['FECHAMENTO']),
    responsavel: campos['RESPONSAVEL'] ?? null,
    vendas_qtd: campos['VENDAS QTD'] ? Number(digits(campos['VENDAS QTD'])) : null,
    vendas_total: num(campos['VENDAS TOTAL']),
    valor_abertura: num(campos['VALOR ABERTURA']),
    sistema: completa(sistema),
    contado: completa(contado),
    tem_sistema: Object.keys(sistema).length > 0,
    tem_contado: Object.keys(contado).length > 0,
    maquininhas,
    delivery,
    despesas,
    repasse: num(campos['REPASSE']),
    troco: num(campos['TROCO']),
    observacoes: campos['OBSERVACOES'] ?? campos['OBS'] ?? null,
  }
}

// ---------- descobrir a loja ----------
async function acharLoja(unidade: string, cnpj: string) {
  const { data: units, error } = await admin.from('units').select('id, nome, apelidos, companies(cnpj)')
  if (error) throw error
  const cnpjDig = digits(cnpj)
  // 1) pelo CNPJ (8 primeiros números ou completo)
  if (cnpjDig.length >= 8) {
    for (const u of units ?? []) {
      const nums = [
        ...String(u.apelidos ?? '').split(',').map(digits),
        digits(String((u as any).companies?.cnpj ?? '')),
      ].filter((d) => d.length >= 8)
      if (nums.some((d) => cnpjDig.startsWith(d.slice(0, 8)))) return u
    }
  }
  // 2) pelo nome/apelido (o apelido mais comprido que aparecer no texto ganha)
  const alvo = norm(unidade)
  if (!alvo) return null
  let melhor: { u: any; tam: number } | null = null
  for (const u of units ?? []) {
    const nomes = [u.nome, ...String(u.apelidos ?? '').split(',')].map((s) => norm(String(s))).filter((s) => s.length >= 3)
    for (const n of nomes) {
      if (alvo === n || alvo.includes(n)) {
        if (!melhor || n.length > melhor.tam) melhor = { u, tam: n.length }
      }
    }
  }
  return melhor?.u ?? null
}

// ---------- configuração e resposta no grupo ----------
async function config() {
  const { data } = await admin.from('app_secrets').select('name, value').in('name', [
    'whatsapp_webhook_token', 'waha_url', 'waha_api_key', 'waha_session', 'whatsapp_group_ids',
  ])
  return Object.fromEntries((data ?? []).map((r) => [r.name, r.value ?? ''])) as Record<string, string>
}

async function responder(cfg: Record<string, string>, chatId: string, texto: string, replyTo?: string) {
  if (!cfg.waha_url) return false
  const r = await fetch(`${cfg.waha_url.replace(/\/$/, '')}/api/sendText`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(cfg.waha_api_key ? { 'X-Api-Key': cfg.waha_api_key } : {}) },
    body: JSON.stringify({ session: cfg.waha_session || 'default', chatId, text: texto, reply_to: replyTo }),
  }).catch((e) => (console.error('WAHA sendText falhou', e), null))
  if (r && !r.ok) console.error('WAHA sendText', r.status, await r.text().catch(() => ''))
  return !!r?.ok
}

// ---------- processamento ----------
async function processar(texto: string, salvar: boolean) {
  const f = lerFechamento(texto)
  const faltando: string[] = []
  if (!f.unidade && !f.cnpj) faltando.push('UNIDADE')
  if (!f.data) faltando.push('DATA (dd/mm/aaaa)')
  if (f.vendas_total == null) faltando.push('VENDAS TOTAL')
  if (!f.tem_sistema) faltando.push('SISTEMA (dinheiro, débito...)')
  if (!f.tem_contado) faltando.push('CONTADO (dinheiro, débito...)')
  if (faltando.length) {
    return { ok: false, erro: `faltando: ${faltando.join(', ')}`, resposta: `❌ Não consegui registrar o fechamento.\nFaltou: ${faltando.join(', ')}.\nCorrija e mande a mensagem inteira de novo.` }
  }
  const loja = await acharLoja(f.unidade, f.cnpj)
  if (!loja) {
    return { ok: false, erro: `loja não encontrada: ${f.unidade}`, resposta: `❌ Não reconheci a unidade "${f.unidade}".\nConfira o nome da UNIDADE ou o CNPJ e mande de novo.` }
  }

  // diferenças contado − sistema
  const difs = FORMAS.map((k) => ({ k, d: Math.round((f.contado[k] - f.sistema[k]) * 100) / 100 }))
  const nomesF: Record<string, string> = { dinheiro: 'Dinheiro', debito: 'Débito', credito: 'Crédito', outros: 'Outros', pix: 'PIX' }
  const difTxt = difs.filter((x) => x.d !== 0).map((x) => `${nomesF[x.k]} ${sinal(x.d)}`)

  // conferência do troco: abertura + dinheiro contado − despesas − repasse
  const avisos: string[] = []
  if (f.valor_abertura != null && f.repasse != null && f.troco != null) {
    const despesas = f.despesas.reduce((s, d) => s + d.valor, 0)
    const esperado = Math.round((f.valor_abertura + f.contado.dinheiro - despesas - f.repasse) * 100) / 100
    if (Math.abs(esperado - f.troco) > 0.05) avisos.push(`⚠️ Troco informado R$ ${brl(f.troco)}, pela conta daria R$ ${brl(esperado)}. Confira.`)
  }

  const registro = {
    unit_id: loja.id,
    data: f.data,
    abertura_at: f.abertura_at,
    fechamento_at: f.fechamento_at,
    responsavel: f.responsavel,
    vendas_qtd: f.vendas_qtd,
    vendas_total: f.vendas_total,
    valor_abertura: f.valor_abertura,
    sistema: f.sistema,
    contado: f.contado,
    maquininhas: f.maquininhas,
    delivery: f.delivery,
    despesas: f.despesas,
    repasse: f.repasse,
    troco: f.troco,
    observacoes: f.observacoes,
    texto_original: texto.trim(),
    origem: 'whatsapp',
    updated_at: new Date().toISOString(),
  }

  let closingId: string | null = null
  let jaExistia = false
  if (salvar) {
    const { data: antes } = await admin.from('cash_closings').select('id').eq('unit_id', loja.id).eq('data', f.data).maybeSingle()
    jaExistia = !!antes
    const { data: salvo, error } = await admin.from('cash_closings').upsert(registro, { onConflict: 'unit_id,data' }).select('id').single()
    if (error) throw error
    closingId = salvo.id
  }

  const resposta = [
    `${jaExistia ? '🔄 Fechamento atualizado' : '✅ Fechamento registrado'} no Onion Cost`,
    `${loja.nome} · ${brData(f.data!)}${f.responsavel ? ` · ${f.responsavel}` : ''}`,
    `Vendas: R$ ${brl(f.vendas_total!)}${f.vendas_qtd ? ` (${f.vendas_qtd})` : ''}`,
    difTxt.length ? `Diferenças (contado − sistema): ${difTxt.join(' | ')}` : 'Sem diferenças entre contado e sistema 👍',
    ...(f.repasse != null || f.troco != null ? [`Repasse R$ ${brl(f.repasse ?? 0)} · Troco R$ ${brl(f.troco ?? 0)}`] : []),
    ...avisos,
  ].join('\n')

  return { ok: true, closingId, jaExistia, loja: loja.nome, registro, resposta }
}

const ehFechamento = (t: string) => /^\W*#?\s*FECHAMENTO\b/i.test(norm(t.replace(/[*_~]/g, '')))

Deno.serve(async (req) => {
  try {
    const url = new URL(req.url)
    const cfg = await config()
    if (!cfg.whatsapp_webhook_token || url.searchParams.get('token') !== cfg.whatsapp_webhook_token) {
      return json({ error: 'token inválido' }, 401)
    }
    const body = await req.json().catch(() => ({}))

    // modo teste: { "texto": "..." } com &dry=1 (não salva, não responde)
    if (url.searchParams.get('dry') === '1') {
      return json(await processar(String(body.texto ?? ''), false))
    }

    // webhook da WAHA: { event: "message", session, payload: { id, from, participant, body, fromMe, ... } }
    const p = body?.payload ?? {}
    if (body?.event !== 'message' || p.fromMe) return json({ ignorado: 'evento' })
    const texto = String(p.body ?? '')
    const chatId = String(p.from ?? '')

    // comando auxiliar: "#ID" faz o robô responder o id do grupo
    if (/^#ID\s*$/i.test(texto.trim())) {
      await responder(cfg, chatId, `ID deste grupo: ${chatId}`, p.id)
      return json({ ok: true, chatId })
    }
    if (!ehFechamento(texto)) return json({ ignorado: 'não é fechamento' })

    const grupos = (cfg.whatsapp_group_ids ?? '').split(',').map((s) => s.trim()).filter(Boolean)
    if (grupos.length && !grupos.includes(chatId)) return json({ ignorado: 'grupo não autorizado' })

    // evita processar a mesma mensagem duas vezes
    const msgId = String(p.id ?? crypto.randomUUID())
    const { data: log, error: logErr } = await admin.from('whatsapp_mensagens').insert({
      msg_id: msgId, chat_id: chatId, remetente: p.participant ?? p.author ?? p.from,
      remetente_nome: p._data?.notifyName ?? p._data?.pushName ?? null, texto,
    }).select('id').single()
    if (logErr) {
      if (logErr.code === '23505') return json({ ignorado: 'mensagem repetida' })
      throw logErr
    }

    let r
    try {
      r = await processar(texto, true)
    } catch (e) {
      console.error(e)
      r = { ok: false, erro: (e as Error).message ?? String(e), resposta: '❌ Deu um erro ao salvar o fechamento. Avise o administrador.' }
    }
    await admin.from('whatsapp_mensagens').update({
      status: r.ok ? 'ok' : 'erro', erro: r.ok ? null : r.erro, closing_id: (r as any).closingId ?? null,
    }).eq('id', log.id)
    await responder(cfg, chatId, r.resposta, p.id)
    return json({ ok: r.ok, resposta: r.resposta })
  } catch (e) {
    console.error(e)
    return json({ error: (e as Error).message ?? String(e) }, 500)
  }
})
