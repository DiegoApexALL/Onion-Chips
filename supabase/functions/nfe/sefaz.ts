// Partes "puras" da consulta à SEFAZ (sem APIs do Deno), para poder testar à parte.
// Serviço: NFeDistribuicaoDFe (Ambiente Nacional), NT 2014.002.

export const SEFAZ_HOST = 'www1.nfe.fazenda.gov.br'
export const SEFAZ_PATH = '/NFeDistribuicaoDFe/NFeDistribuicaoDFe.asmx'
export const SOAP_ACTION = 'http://www.portalfiscal.inf.br/nfe/wsdl/NFeDistribuicaoDFe/nfeDistDFeInteresse'

export const UF_CODE: Record<string, number> = {
  RO: 11, AC: 12, AM: 13, RR: 14, PA: 15, AP: 16, TO: 17, MA: 21, PI: 22, CE: 23, RN: 24, PB: 25, PE: 26, AL: 27,
  SE: 28, BA: 29, MG: 31, ES: 32, RJ: 33, SP: 35, PR: 41, SC: 42, RS: 43, MS: 50, MT: 51, GO: 52, DF: 53,
}

export function buildEnvelope(cnpj: string, uf: string, ultNSU: number): string {
  const code = UF_CODE[uf]
  if (!code) throw new Error(`UF inválida: ${uf}`)
  if (!/^\d{14}$/.test(cnpj)) throw new Error('CNPJ inválido')
  const nsu = String(Math.max(0, Math.trunc(ultNSU))).padStart(15, '0')
  return '<?xml version="1.0" encoding="utf-8"?>' +
    '<soap12:Envelope xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:soap12="http://www.w3.org/2003/05/soap-envelope">' +
    '<soap12:Body><nfeDistDFeInteresse xmlns="http://www.portalfiscal.inf.br/nfe/wsdl/NFeDistribuicaoDFe"><nfeDadosMsg>' +
    `<distDFeInt xmlns="http://www.portalfiscal.inf.br/nfe" versao="1.01"><tpAmb>1</tpAmb><cUFAutor>${code}</cUFAutor>` +
    `<CNPJ>${cnpj}</CNPJ><distNSU><ultNSU>${nsu}</ultNSU></distNSU></distDFeInt>` +
    '</nfeDadosMsg></nfeDistDFeInteresse></soap12:Body></soap12:Envelope>'
}

/** Conteúdo da primeira tag com esse nome (ignora prefixo de namespace). */
export function tag(xml: string, name: string): string | null {
  const m = xml.match(new RegExp(`<(?:[\\w-]+:)?${name}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:[\\w-]+:)?${name}>`))
  return m ? m[1] : null
}

function text(xml: string, name: string): string | null {
  const v = tag(xml, name)
  return v == null ? null : decodeEntities(v.trim())
}

export function decodeEntities(s: string): string {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&')
}

export interface DocZip { nsu: number; schema: string; b64: string }
export interface RetDist { cStat: number; xMotivo: string; ultNSU: number; maxNSU: number; docs: DocZip[] }

export function parseRet(xml: string): RetDist {
  const ret = tag(xml, 'retDistDFeInt')
  if (ret == null) {
    const fault = text(xml, 'Text') ?? text(xml, 'faultstring')
    throw new Error(fault ? `SEFAZ: ${fault}` : 'Resposta inesperada da SEFAZ')
  }
  const docs: DocZip[] = []
  for (const m of ret.matchAll(/<(?:[\w-]+:)?docZip\s([^>]*)>([\s\S]*?)<\/(?:[\w-]+:)?docZip>/g)) {
    const attrs = m[1]
    docs.push({
      nsu: Number(attrs.match(/NSU="(\d+)"/)?.[1] ?? 0),
      schema: attrs.match(/schema="([^"]+)"/)?.[1] ?? '',
      b64: m[2].replace(/\s+/g, ''),
    })
  }
  return {
    cStat: Number(text(ret, 'cStat')),
    xMotivo: text(ret, 'xMotivo') ?? '',
    ultNSU: Number(text(ret, 'ultNSU') ?? 0),
    maxNSU: Number(text(ret, 'maxNSU') ?? 0),
    docs,
  }
}

export async function gunzipBase64(b64: string): Promise<string> {
  const bin = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))
  const stream = new Blob([bin]).stream().pipeThrough(new DecompressionStream('gzip'))
  return await new Response(stream).text()
}

export type ParsedDoc =
  | {
      kind: 'nfe'
      chave: string
      emit_doc: string | null
      emit_nome: string | null
      dh_emi: string | null
      competencia: string | null
      valor: number | null
      situacao: 'autorizada' | 'denegada' | 'cancelada'
      completa: boolean
    }
  | { kind: 'cancel'; chave: string }

const SITUACAO = { '1': 'autorizada', '2': 'denegada', '3': 'cancelada' } as const

function competencia(dh: string | null): string | null {
  // dhEmi vem como "2026-10-05T10:20:00-03:00": o mês é o da data local de emissão
  return dh && /^\d{4}-\d{2}/.test(dh) ? dh.slice(0, 7) : null
}

function num(v: string | null): number | null {
  if (v == null || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

/** Interpreta um documento descompactado. Eventos que não sejam cancelamento são ignorados. */
export function parseDoc(schema: string, xml: string): ParsedDoc | null {
  if (schema.startsWith('resNFe')) {
    const chave = text(xml, 'chNFe')
    if (!chave) return null
    const dh = text(xml, 'dhEmi')
    return {
      kind: 'nfe',
      chave,
      emit_doc: text(xml, 'CNPJ') ?? text(xml, 'CPF'),
      emit_nome: text(xml, 'xNome'),
      dh_emi: dh,
      competencia: competencia(dh),
      valor: num(text(xml, 'vNF')),
      situacao: SITUACAO[(text(xml, 'cSitNFe') ?? '1') as keyof typeof SITUACAO] ?? 'autorizada',
      completa: false,
    }
  }
  if (schema.startsWith('procNFe')) {
    const inf = tag(xml, 'infNFe') ?? xml
    const emit = tag(inf, 'emit') ?? ''
    const ide = tag(inf, 'ide') ?? ''
    const total = tag(inf, 'ICMSTot') ?? tag(inf, 'total') ?? ''
    const chave = text(tag(xml, 'infProt') ?? '', 'chNFe') ?? xml.match(/Id="NFe(\d{44})"/)?.[1] ?? null
    if (!chave) return null
    const dh = text(ide, 'dhEmi') ?? (text(ide, 'dEmi') ? `${text(ide, 'dEmi')}T00:00:00-03:00` : null)
    const cStat = text(tag(xml, 'infProt') ?? '', 'cStat')
    return {
      kind: 'nfe',
      chave,
      emit_doc: text(emit, 'CNPJ') ?? text(emit, 'CPF'),
      emit_nome: text(emit, 'xNome'),
      dh_emi: dh,
      competencia: competencia(dh),
      valor: num(text(total, 'vNF')),
      situacao: cStat && ['110', '301', '302', '303'].includes(cStat) ? 'denegada' : 'autorizada',
      completa: true,
    }
  }
  if (schema.startsWith('resEvento') || schema.startsWith('procEventoNFe')) {
    const tp = text(xml, 'tpEvento')
    const chave = text(xml, 'chNFe')
    // 110111 = cancelamento; 110112 = cancelamento por substituição
    if (chave && (tp === '110111' || tp === '110112')) return { kind: 'cancel', chave }
    return null
  }
  return null
}

/** Mês corrente no horário de Brasília, no formato AAAA-MM. */
export function currentMonth(now = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit' }).formatToParts(now)
  return `${parts.find((p) => p.type === 'year')!.value}-${parts.find((p) => p.type === 'month')!.value}`
}

// ---------- HTTP/1.1 mínimo (usado sobre a conexão TLS com certificado) ----------

export function buildHttpRequest(body: string): Uint8Array {
  const payload = new TextEncoder().encode(body)
  const head = `POST ${SEFAZ_PATH} HTTP/1.1\r\nHost: ${SEFAZ_HOST}\r\n` +
    `Content-Type: application/soap+xml; charset=utf-8; action="${SOAP_ACTION}"\r\n` +
    `Content-Length: ${payload.length}\r\nConnection: close\r\nUser-Agent: OnionCost/1.0\r\n\r\n`
  const headBytes = new TextEncoder().encode(head)
  const out = new Uint8Array(headBytes.length + payload.length)
  out.set(headBytes)
  out.set(payload, headBytes.length)
  return out
}

function indexOfSeq(buf: Uint8Array, seq: number[], from = 0): number {
  outer: for (let i = from; i <= buf.length - seq.length; i++) {
    for (let j = 0; j < seq.length; j++) if (buf[i + j] !== seq[j]) continue outer
    return i
  }
  return -1
}
const CRLFCRLF = [13, 10, 13, 10]

export interface HttpResponse { status: number; body: string }

/** Tenta montar a resposta; devolve null se ainda faltam bytes. */
export function parseHttpResponse(buf: Uint8Array, eof: boolean): HttpResponse | null {
  const end = indexOfSeq(buf, CRLFCRLF)
  if (end < 0) {
    if (eof) throw new Error('A SEFAZ fechou a conexão sem responder')
    return null
  }
  const head = new TextDecoder().decode(buf.subarray(0, end))
  const status = Number(head.match(/^HTTP\/1\.[01] (\d{3})/)?.[1] ?? 0)
  let body = buf.subarray(end + 4)
  if (/\r\ntransfer-encoding:\s*chunked/i.test(head)) {
    const chunks: Uint8Array[] = []
    let pos = 0
    for (;;) {
      const lineEnd = indexOfSeq(body, [13, 10], pos)
      if (lineEnd < 0) return eof ? done() : null
      const size = parseInt(new TextDecoder().decode(body.subarray(pos, lineEnd)).split(';')[0].trim(), 16)
      if (!Number.isFinite(size)) throw new Error('Resposta HTTP inválida')
      if (size === 0) return done()
      if (body.length < lineEnd + 2 + size + 2) return eof ? done() : null
      chunks.push(body.subarray(lineEnd + 2, lineEnd + 2 + size))
      pos = lineEnd + 2 + size + 2
    }
    function done(): HttpResponse {
      const total = chunks.reduce((n, c) => n + c.length, 0)
      const out = new Uint8Array(total)
      let o = 0
      for (const c of chunks) { out.set(c, o); o += c.length }
      return { status, body: new TextDecoder().decode(out) }
    }
  }
  const len = head.match(/\r\ncontent-length:\s*(\d+)/i)
  if (len) {
    const n = Number(len[1])
    if (body.length < n) return eof ? { status, body: new TextDecoder().decode(body) } : null
    body = body.subarray(0, n)
  } else if (!eof) {
    return null
  }
  return { status, body: new TextDecoder().decode(body) }
}
