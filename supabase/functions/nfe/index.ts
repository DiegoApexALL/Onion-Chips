// Edge Function "nfe" — Cadastro Empresas / consulta de NF-e recebidas na SEFAZ.
//
// Ações (POST JSON, usuário logado no app):
//   { action: "save-cert",   company_id, pfx (base64), password }  → guarda o certificado A1 criptografado
//   { action: "remove-cert", company_id }                           → apaga o certificado
//   { action: "consult",     company_id }                           → resumo do mês e situação da sincronização
//
// A consulta à SEFAZ em si roda no GitHub Actions (.github/workflows/sefaz-sync.yml), porque a SEFAZ
// pede o certificado por renegociação TLS, que o Deno (rustls) não suporta e o Node (OpenSSL) sim.
// O workflow se identifica com o token OIDC do GitHub (sem senha guardada) e usa:
//   { action: "sync-jobs" }                                          → empresas a sincronizar (com certificado)
//   { action: "sync-ingest", company_id, response? | error? }        → grava uma resposta da SEFAZ (NF-e recebidas)
//   { action: "nfce-list-ingest", company_id, cursor, response? | error? } → chaves de NFC-e emitidas (SEFAZ-SP)
//   { action: "nfce-xml-ingest", company_id, chave, response? | error? }   → XML de uma NFC-e (valor, cancelamento)
//
// Segredo opcional (Supabase > Edge Functions > Secrets):
//   CERT_SECRET   — chave usada para criptografar os certificados (se faltar, usa a service role key)

import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2'
import {
  competenciaFromKey, currentMonth, fromLocal, gunzipBase64, localMinute, parseDoc, parseNfceList, parseNfceXml, parseRet,
  type ParsedDoc,
} from './sefaz.ts'
import { readPfx, UserError } from './cert.ts'
import { createRemoteJWKSet, jwtVerify } from 'npm:jose@5.9.6'

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } })
}

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const admin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } })

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })
  if (req.method !== 'POST') return json({ error: 'Use POST' }, 405)
  try {
    const gh = req.headers.get('x-github-oidc')
    if (gh) return json(await githubSync(gh, await req.json().catch(() => ({}))))

    const token = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '')
    const auth = token ? await admin.auth.getUser(token) : null
    if (!auth || auth.error || !auth.data.user) return json({ error: 'Entre no app para usar esta função.' }, 401)

    const body = await req.json().catch(() => ({}))
    const companyId = String(body.company_id ?? '')
    if (!companyId) throw new UserError('Empresa não informada.')
    const { data: company, error } = await admin.from('companies').select('*').eq('id', companyId).maybeSingle()
    if (error) throw error
    if (!company) throw new UserError('Empresa não encontrada.')

    switch (body.action) {
      case 'save-cert':
        return json(await saveCert(company, String(body.pfx ?? ''), String(body.password ?? '')))
      case 'remove-cert':
        await admin.from('company_certs').delete().eq('company_id', companyId)
        await admin.from('companies').update({ cert_subject: null, cert_valid_until: null }).eq('id', companyId)
        return json({ ok: true })
      case 'consult':
        return json(await consult(admin, company))
      default:
        throw new UserError('Ação desconhecida.')
    }
  } catch (e) {
    const msg = (e as { message?: string })?.message ?? String(e)
    console.error(msg)
    return json({ error: msg }, e instanceof UserError ? 400 : 500)
  }
})

// ---------------- Certificado ----------------

interface Company {
  id: string; cnpj: string; name: string; uf: string
  last_nsu: number; max_nsu: number | null; next_sync_at: string | null
}

async function aesKey(): Promise<CryptoKey> {
  const secret = Deno.env.get('CERT_SECRET') || SERVICE_KEY
  const raw = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`onion-cost-cert:${secret}`))
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt'])
}
const b64 = (u: Uint8Array) => btoa(String.fromCharCode(...u))
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0))

async function encrypt(data: unknown): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await aesKey(), new TextEncoder().encode(JSON.stringify(data))))
  // base64 em pedaços para não estourar a pilha com arquivos grandes
  let out = ''
  for (let i = 0; i < ct.length; i += 0x8000) out += String.fromCharCode(...ct.subarray(i, i + 0x8000))
  return `${b64(iv)}.${btoa(out)}`
}

async function decrypt<T>(payload: string): Promise<T> {
  const [iv, ct] = payload.split('.')
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(iv) }, await aesKey(), unb64(ct))
  return JSON.parse(new TextDecoder().decode(pt))
}

async function saveCert(company: Company, pfx: string, password: string) {
  if (!pfx) throw new UserError('Escolha o arquivo do certificado (.pfx ou .p12).')
  if (pfx.length > 200_000) throw new UserError('Arquivo grande demais para um certificado A1.')
  const pem = readPfx(pfx, password)
  if (pem.cnpj && pem.cnpj.slice(0, 8) !== company.cnpj.slice(0, 8)) {
    throw new UserError(`Este certificado é do CNPJ ${fmtCnpj(pem.cnpj)}, que não pertence a ${fmtCnpj(company.cnpj)}.`)
  }
  if (pem.notAfter.getTime() < Date.now()) throw new UserError(`Certificado vencido em ${pem.notAfter.toLocaleDateString('pt-BR')}.`)
  const payload = await encrypt({ pfx, password })
  const up = await admin.from('company_certs').upsert({ company_id: company.id, payload, updated_at: new Date().toISOString() })
  if (up.error) throw up.error
  const upd = await admin.from('companies')
    .update({ cert_subject: pem.subject, cert_valid_until: pem.notAfter.toISOString() })
    .eq('id', company.id)
  if (upd.error) throw upd.error
  return { ok: true, subject: pem.subject, valid_until: pem.notAfter.toISOString() }
}

function fmtCnpj(c: string) {
  return c.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, '$1.$2.$3/$4-$5')
}

// ---------------- SEFAZ (via GitHub Actions) ----------------

const HOUR = 60 * 60 * 1000
const GH_REPO = 'DiegoApexALL/Onion-Chips'
const GH_REF = 'refs/heads/claude/onion-cost-app-clone-qdy4s1'
const GH_AUDIENCE = 'onion-cost'
const ghKeys = createRemoteJWKSet(new URL('https://token.actions.githubusercontent.com/.well-known/jwks'))

/** Confere o token OIDC: só o workflow deste repositório, na branch principal, agendado ou manual. */
async function verifyGithub(token: string) {
  const { payload } = await jwtVerify(token, ghKeys, {
    issuer: 'https://token.actions.githubusercontent.com',
    audience: GH_AUDIENCE,
  })
  const ok = String(payload.repository).toLowerCase() === GH_REPO.toLowerCase() &&
    payload.ref === GH_REF &&
    ['schedule', 'workflow_dispatch'].includes(String(payload.event_name)) &&
    String(payload.workflow_ref ?? '').includes('/.github/workflows/sefaz-sync.yml@')
  if (!ok) throw new UserError('Token do GitHub não autorizado.')
}

async function githubSync(token: string, body: Record<string, unknown>) {
  try {
    await verifyGithub(token)
  } catch (e) {
    throw e instanceof UserError ? e : new UserError(`Token do GitHub inválido: ${(e as Error).message}`)
  }
  if (body.action === 'sync-jobs') return { jobs: await syncJobs() }
  if (body.action === 'sync-ingest') return await syncIngest(String(body.company_id ?? ''), body)
  if (body.action === 'nfce-list-ingest') return await nfceListIngest(String(body.company_id ?? ''), body)
  if (body.action === 'nfce-xml-ingest') return await nfceXmlIngest(String(body.company_id ?? ''), body)
  throw new UserError('Ação desconhecida.')
}

const NFCE_DOWNLOADS_PER_RUN = 20

/** Primeiro dia do mês, dois meses atrás (a SEFAZ-SP guarda ~100 dias). */
function nfceStart(): Date {
  const [y, m] = currentMonth().split('-').map(Number)
  const d = new Date(Date.UTC(y, m - 3, 1, 3, 0)) // 00:00 em Brasília
  const min = new Date(Date.now() - 95 * 24 * HOUR)
  return d < min ? min : d
}

async function syncJobs() {
  const now = Date.now()
  const { data, error } = await admin.from('companies').select('id, cnpj, uf, last_nsu, next_sync_at, nfce_cursor, nfce_next_at')
  if (error) throw error
  const jobs = []
  for (const c of data ?? []) {
    const nfeDue = !c.next_sync_at || new Date(c.next_sync_at).getTime() <= now
    const isSP = c.uf === 'SP'
    const listDue = isSP && (!c.nfce_next_at || new Date(c.nfce_next_at).getTime() <= now)
    let downloads: string[] = []
    if (isSP && (!c.nfce_next_at || new Date(c.nfce_next_at).getTime() <= now + HOUR)) {
      const { data: pend } = await admin.from('nfce_docs').select('chave')
        .eq('company_id', c.id).eq('baixada', false).lt('tentativas', 5)
        .order('competencia', { ascending: false }).order('chave', { ascending: false })
        .limit(NFCE_DOWNLOADS_PER_RUN)
      downloads = (pend ?? []).map((r) => r.chave)
    }
    if (!nfeDue && !listDue && !downloads.length) continue
    const { data: row } = await admin.from('company_certs').select('payload').eq('company_id', c.id).maybeSingle()
    if (!row) continue
    try {
      const { pfx, password } = await decrypt<{ pfx: string; password: string }>(row.payload)
      const pem = readPfx(pfx, password)
      if (pem.notAfter.getTime() < now) {
        await admin.from('companies').update({ last_status: 'Certificado vencido: envie o novo para continuar.' }).eq('id', c.id)
        continue
      }
      const cursor = c.nfce_cursor ? new Date(c.nfce_cursor) : nfceStart()
      jobs.push({
        company_id: c.id, cnpj: c.cnpj, uf: c.uf, cert: pem.cert, key: pem.key,
        nfe: nfeDue ? { last_nsu: Number(c.last_nsu) || 0 } : null,
        nfce: isSP ? { list: listDue, cursor: localMinute(cursor < nfceStart() ? nfceStart() : cursor), downloads } : null,
      })
    } catch (e) {
      await admin.from('companies').update({ last_status: `Erro no certificado: ${(e as Error).message}` }).eq('id', c.id)
    }
  }
  return jobs
}

/** Grava as chaves de uma página da listagem de NFC-e e diz se há mais páginas. */
async function nfceListIngest(companyId: string, body: Record<string, unknown>) {
  const later = new Date(Date.now() + HOUR).toISOString()
  const save = (fields: Record<string, unknown>) =>
    admin.from('companies').update({ nfce_sync_at: new Date().toISOString(), ...fields }).eq('id', companyId)
  if (body.error) {
    await save({ nfce_next_at: later, nfce_status: `Erro ao consultar a SEFAZ-SP: ${String(body.error).slice(0, 300)}` })
    return { done: true }
  }
  let ret
  try {
    ret = parseNfceList(String(body.response ?? ''))
  } catch (e) {
    await save({ nfce_next_at: later, nfce_status: (e as Error).message })
    return { done: true }
  }
  if (ret.cStat === 656) {
    await save({ nfce_next_at: later, nfce_status: 'A SEFAZ-SP pediu para aguardar (consumo indevido).' })
    return { done: true, stop: true }
  }
  if (![100, 101, 107].includes(ret.cStat)) {
    await save({ nfce_next_at: later, nfce_status: `SEFAZ-SP: ${ret.cStat} - ${ret.xMotivo}` })
    return { done: true }
  }
  if (ret.chaves.length) {
    const rows = ret.chaves.map((chave) => ({ company_id: companyId, chave, competencia: competenciaFromKey(chave) }))
    for (let i = 0; i < rows.length; i += 500) {
      const up = await admin.from('nfce_docs').upsert(rows.slice(i, i + 500), { onConflict: 'company_id,chave', ignoreDuplicates: true })
      if (up.error) throw up.error
    }
  }
  if (ret.cStat === 101 && ret.dhEmisUltNfce) {
    // Mais de 2.000 chaves: continua a partir da última emissão devolvida
    const cursor = String(body.cursor ?? '')
    let next = ret.dhEmisUltNfce.slice(0, 16)
    if (next <= cursor) next = localMinute(new Date(fromLocal(cursor).getTime() + 60_000))
    await save({ nfce_cursor: fromLocal(next).toISOString(), nfce_status: 'Listando NFC-e emitidas…' })
    return { done: false, cursor: next, keys: ret.chaves.length }
  }
  // Lista completa: na próxima vez, relista só os últimos 2 dias (notas em contingência chegam depois)
  await save({
    nfce_cursor: new Date(Date.now() - 48 * HOUR).toISOString(),
    nfce_next_at: later,
    nfce_status: 'Lista de NFC-e atualizada.',
  })
  return { done: true, keys: ret.chaves.length }
}

/** Grava valor/data/cancelamento de uma NFC-e baixada. */
async function nfceXmlIngest(companyId: string, body: Record<string, unknown>) {
  const chave = String(body.chave ?? '')
  const { data: cur } = await admin.from('nfce_docs').select('tentativas').eq('company_id', companyId).eq('chave', chave).maybeSingle()
  if (!cur) throw new UserError('NFC-e não encontrada.')
  const fail = () => admin.from('nfce_docs').update({ tentativas: cur.tentativas + 1, updated_at: new Date().toISOString() })
    .eq('company_id', companyId).eq('chave', chave)
  if (body.error) {
    await fail()
    return { ok: false }
  }
  let ret
  try {
    ret = parseNfceXml(String(body.response ?? ''))
  } catch {
    await fail()
    return { ok: false }
  }
  if (ret.cStat === 656) {
    await admin.from('companies').update({ nfce_status: 'A SEFAZ-SP pediu para aguardar antes de baixar mais NFC-e.' }).eq('id', companyId)
    return { ok: false, stop: true }
  }
  if (ret.cStat !== 200) {
    // 205 (não encontrada) / 207 (antiga demais): não adianta insistir muito
    await admin.from('nfce_docs').update({
      tentativas: [205, 207, 204, 203].includes(ret.cStat) ? 99 : cur.tentativas + 1, updated_at: new Date().toISOString(),
    }).eq('company_id', companyId).eq('chave', chave)
    return { ok: false, cStat: ret.cStat }
  }
  const up = await admin.from('nfce_docs').update({
    baixada: true,
    valor: ret.valor,
    dh_emi: ret.dh_emi,
    ...(ret.competencia ? { competencia: ret.competencia } : {}),
    situacao: ret.cancelada ? 'cancelada' : 'autorizada',
    updated_at: new Date().toISOString(),
  }).eq('company_id', companyId).eq('chave', chave)
  if (up.error) throw up.error
  return { ok: true }
}

/** Grava uma resposta da SEFAZ e diz ao workflow se deve continuar e com qual NSU. */
async function syncIngest(companyId: string, body: Record<string, unknown>) {
  const { data: company, error } = await admin.from('companies').select('*').eq('id', companyId).maybeSingle()
  if (error) throw error
  if (!company) throw new UserError('Empresa não encontrada.')
  const nowIso = new Date().toISOString()
  const later = new Date(Date.now() + HOUR).toISOString()
  const save = (fields: Record<string, unknown>) => admin.from('companies').update({ last_sync_at: nowIso, ...fields }).eq('id', companyId)

  if (body.error) {
    const msg = String(body.error).slice(0, 300)
    await save({ next_sync_at: later, last_status: `Erro ao consultar a SEFAZ: ${msg}` })
    return { done: true }
  }
  let ret
  try {
    ret = parseRet(String(body.response ?? ''))
  } catch (e) {
    await save({ next_sync_at: later, last_status: (e as Error).message })
    return { done: true }
  }
  if (ret.cStat === 137) {
    await save({
      last_nsu: ret.ultNSU || company.last_nsu, max_nsu: ret.maxNSU || company.max_nsu,
      next_sync_at: later, last_status: 'Atualizado. Nenhuma nota nova na SEFAZ.',
    })
    return { done: true }
  }
  if (ret.cStat === 656) {
    await save({ next_sync_at: later, last_status: 'A SEFAZ pediu para aguardar 1 hora (consumo indevido).' })
    return { done: true }
  }
  if (ret.cStat !== 138) {
    await save({ next_sync_at: later, last_status: `SEFAZ: ${ret.cStat} - ${ret.xMotivo}` })
    return { done: true }
  }
  const fetched = await saveDocs(admin, companyId, ret.docs)
  const done = ret.ultNSU >= ret.maxNSU
  await save({
    last_nsu: ret.ultNSU, max_nsu: ret.maxNSU,
    ...(done ? { next_sync_at: later } : {}),
    last_status: done ? 'Atualizado com a SEFAZ.' : 'Baixando notas da SEFAZ…',
  })
  return { done, ult_nsu: ret.ultNSU, fetched }
}

/** Botão "Consultar" do app: mostra o que já foi sincronizado. */
async function consult(sb: SupabaseClient, company: Company) {
  const { data: certRow } = await sb.from('company_certs').select('company_id').eq('company_id', company.id).maybeSingle()
  if (!certRow) throw new UserError('Envie o certificado digital A1 desta empresa antes de consultar.')
  const { data: c } = await sb.from('companies').select('last_sync_at, next_sync_at, last_status').eq('id', company.id).single()
  const status = c?.last_sync_at
    ? (c.last_status ?? 'Atualizado.')
    : 'Certificado recebido. A primeira consulta à SEFAZ acontece automaticamente em até 15 minutos.'
  return { status, pending: false, fetched: 0, ...(await monthSummary(sb, company.id)), ...c }
}

async function saveDocs(sb: SupabaseClient, companyId: string, docs: { nsu: number; schema: string; b64: string }[]) {
  const parsed: (ParsedDoc & { nsu: number })[] = []
  for (const d of docs) {
    try {
      const doc = parseDoc(d.schema, await gunzipBase64(d.b64))
      if (doc) parsed.push({ ...doc, nsu: d.nsu })
    } catch (e) {
      console.error(`NSU ${d.nsu}: ${(e as Error).message}`)
    }
  }
  if (!parsed.length) return 0
  const chaves = [...new Set(parsed.map((p) => p.chave))]
  const { data: existing, error } = await sb.from('nfe_docs').select('*').eq('company_id', companyId).in('chave', chaves)
  if (error) throw error
  const rows = new Map<string, Record<string, unknown>>((existing ?? []).map((r) => [r.chave as string, r]))
  for (const p of parsed) {
    const cur = rows.get(p.chave) ?? { company_id: companyId, chave: p.chave, situacao: 'autorizada', completa: false }
    if (p.kind === 'cancel') {
      cur.situacao = 'cancelada'
    } else {
      const keepFull = cur.completa && !p.completa // não troca XML completo por resumo
      if (!keepFull) {
        Object.assign(cur, {
          emit_doc: p.emit_doc, emit_nome: p.emit_nome, dh_emi: p.dh_emi, competencia: p.competencia, valor: p.valor, completa: p.completa,
        })
      }
      if (cur.situacao !== 'cancelada') cur.situacao = p.situacao
      cur.nsu = p.nsu
    }
    cur.updated_at = new Date().toISOString()
    rows.set(p.chave, cur)
  }
  const up = await sb.from('nfe_docs').upsert([...rows.values()])
  if (up.error) throw up.error
  return parsed.filter((p) => p.kind === 'nfe').length
}

async function monthSummary(sb: SupabaseClient, companyId: string) {
  const month = currentMonth()
  const { data, error } = await sb.from('nfe_docs')
    .select('chave, emit_doc, emit_nome, dh_emi, valor, situacao')
    .eq('company_id', companyId).eq('competencia', month)
    .order('dh_emi', { ascending: false })
  if (error) throw error
  const notes = data ?? []
  const valid = notes.filter((n) => n.situacao === 'autorizada')
  return {
    month,
    count: valid.length,
    total: valid.reduce((s, n) => s + Number(n.valor ?? 0), 0),
    cancelled: notes.filter((n) => n.situacao === 'cancelada').length,
  }
}
