// Edge Function "nfe" — Cadastro Empresas / consulta de NF-e recebidas na SEFAZ.
//
// Ações (POST JSON, usuário logado no app):
//   { action: "save-cert",   company_id, pfx (base64), password }  → guarda o certificado A1 criptografado
//   { action: "remove-cert", company_id }                           → apaga o certificado
//   { action: "consult",     company_id }                           → busca novidades na SEFAZ e resume o mês
//
// Segredos opcionais (Supabase > Edge Functions > Secrets):
//   CERT_SECRET   — chave usada para criptografar os certificados (se faltar, usa a service role key)
//   SEFAZ_CA_PEM  — certificados raiz extras (PEM) caso a SEFAZ use uma cadeia ICP-Brasil não reconhecida

import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2'
import {
  buildEnvelope, buildHttpRequest, currentMonth, gunzipBase64, parseDoc, parseHttpResponse, parseRet,
  SEFAZ_HOST, type ParsedDoc,
} from './sefaz.ts'
import { type Pem, readPfx, UserError } from './cert.ts'

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

// ---------------- SEFAZ ----------------

function splitPem(bundle: string): string[] {
  return bundle.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g) ?? []
}

async function sefazPost(pem: Pem, xml: string): Promise<string> {
  const extraCa = splitPem(Deno.env.get('SEFAZ_CA_PEM') ?? '')
  let conn: Deno.TlsConn
  try {
    conn = await Deno.connectTls({
      hostname: SEFAZ_HOST,
      port: 443,
      cert: pem.cert,
      key: pem.key,
      ...(extraCa.length ? { caCerts: extraCa } : {}),
    } as Deno.ConnectTlsOptions)
  } catch (e) {
    throw tlsError(e)
  }
  const timer = setTimeout(() => { try { conn.close() } catch { /* já fechada */ } }, 45_000)
  try {
    await writeAll(conn, buildHttpRequest(xml))
    let buf = new Uint8Array(0)
    const chunk = new Uint8Array(32 * 1024)
    for (;;) {
      let n: number | null
      try {
        n = await conn.read(chunk)
      } catch (e) {
        // Alguns servidores fecham sem "close_notify": usa o que já chegou
        const partial = buf.length ? parseHttpResponse(buf, true) : null
        if (partial) return checkHttp(partial)
        throw tlsError(e)
      }
      if (n === null) return checkHttp(parseHttpResponse(buf, true)!)
      const next = new Uint8Array(buf.length + n)
      next.set(buf)
      next.set(chunk.subarray(0, n), buf.length)
      buf = next
      const res = parseHttpResponse(buf, false)
      if (res) return checkHttp(res)
    }
  } finally {
    clearTimeout(timer)
    try { conn.close() } catch { /* já fechada */ }
  }
}

async function writeAll(conn: Deno.TlsConn, data: Uint8Array) {
  let off = 0
  while (off < data.length) off += await conn.write(data.subarray(off))
}

function checkHttp(res: { status: number; body: string }): string {
  if (res.status === 403) throw new UserError('A SEFAZ recusou o certificado (HTTP 403). Confira se ele é um e-CNPJ A1 válido.')
  if (res.status !== 200 && !res.body.includes('retDistDFeInt')) {
    throw new Error(`SEFAZ respondeu HTTP ${res.status}: ${res.body.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 300)}`)
  }
  return res.body
}

function tlsError(e: unknown): Error {
  const m = String((e as Error)?.message ?? e)
  if (/UnknownIssuer|unknown ?ca|certificate/i.test(m) && !/client/i.test(m)) {
    return new Error(`Não foi possível validar o certificado do servidor da SEFAZ (${m}). ` +
      'Cadastre a cadeia ICP-Brasil no segredo SEFAZ_CA_PEM da função (veja o README).')
  }
  return new Error(`Falha na conexão segura com a SEFAZ: ${m}`)
}

const HOUR = 60 * 60 * 1000
const MAX_CALLS = 20 // até ~1000 documentos por clique

async function consult(sb: SupabaseClient, company: Company) {
  const now = Date.now()
  let status = ''
  let pending = false
  let fetched = 0

  const waitUntil = company.next_sync_at ? new Date(company.next_sync_at).getTime() : 0
  if (waitUntil > now) {
    status = 'Dados já atualizados há pouco. A SEFAZ só permite nova consulta depois do horário indicado.'
  } else {
    const { data: certRow } = await sb.from('company_certs').select('payload').eq('company_id', company.id).maybeSingle()
    if (!certRow) throw new UserError('Envie o certificado digital A1 desta empresa antes de consultar.')
    const { pfx, password } = await decrypt<{ pfx: string; password: string }>(certRow.payload)
    const pem = readPfx(pfx, password)

    let ult = Number(company.last_nsu) || 0
    let max = Number(company.max_nsu) || 0
    let nextSync: string | null = null
    try {
      for (let i = 0; i < MAX_CALLS; i++) {
        const ret = parseRet(await sefazPost(pem, buildEnvelope(company.cnpj, company.uf, ult)))
        if (ret.cStat === 137) { // nenhum documento novo
          if (ret.ultNSU) ult = ret.ultNSU
          if (ret.maxNSU) max = ret.maxNSU
          nextSync = new Date(now + HOUR).toISOString()
          status = 'Atualizado. Nenhuma nota nova na SEFAZ.'
          break
        }
        if (ret.cStat === 656) { // consumo indevido: bloqueio de 1 hora
          nextSync = new Date(now + HOUR).toISOString()
          status = 'A SEFAZ pediu para aguardar 1 hora antes de consultar de novo (consumo indevido).'
          break
        }
        if (ret.cStat !== 138) throw new UserError(`SEFAZ: ${ret.cStat} - ${ret.xMotivo}`)
        fetched += await saveDocs(sb, company.id, ret.docs)
        ult = ret.ultNSU
        max = ret.maxNSU
        if (ult >= max) {
          nextSync = new Date(now + HOUR).toISOString()
          status = 'Atualizado com a SEFAZ.'
          break
        }
        if (i === MAX_CALLS - 1) {
          pending = true
          status = 'Ainda há notas para baixar. Toque em Consultar de novo para continuar.'
        }
      }
    } finally {
      await sb.from('companies').update({
        last_nsu: ult, max_nsu: max, last_sync_at: new Date().toISOString(),
        ...(nextSync ? { next_sync_at: nextSync } : {}), last_status: status || null,
      }).eq('id', company.id)
    }
  }

  const { data: refreshed } = await sb.from('companies').select('last_sync_at, next_sync_at').eq('id', company.id).single()
  return { status, pending, fetched, ...(await monthSummary(sb, company.id)), ...refreshed }
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
