// Sincronização com a SEFAZ (NFeDistribuicaoDFe), rodando no GitHub Actions.
// Pede à função "nfe" do Supabase as empresas pendentes, consulta a SEFAZ com o certificado
// de cada uma (Node/OpenSSL aceita a renegociação TLS que a SEFAZ usa) e devolve as respostas.
// Nada sensível é impresso no log (o repositório é público).
import https from 'node:https'
import tls from 'node:tls'
import { readFileSync, existsSync } from 'node:fs'

const config = readFileSync(new URL('../src/lib/config.ts', import.meta.url), 'utf8')
const SUPABASE_URL = config.match(/SUPABASE_URL = '([^']+)'/)[1]
const ANON_KEY = config.match(/SUPABASE_ANON_KEY = '([^']+)'/)[1]
const FN = `${SUPABASE_URL}/functions/v1/nfe`

const UF = { RO: 11, AC: 12, AM: 13, RR: 14, PA: 15, AP: 16, TO: 17, MA: 21, PI: 22, CE: 23, RN: 24, PB: 25, PE: 26, AL: 27,
  SE: 28, BA: 29, MG: 31, ES: 32, RJ: 33, SP: 35, PR: 41, SC: 42, RS: 43, MS: 50, MT: 51, GO: 52, DF: 53 }
const MAX_CALLS = 20
const NFCE_HOST = 'nfce.fazenda.sp.gov.br'
// Raiz ICP-Brasil v10 (baixada e conferida pelo workflow): o servidor da SEFAZ-SP usa essa cadeia
const ICP_PEM = process.env.ICP_ROOT_PEM && existsSync(process.env.ICP_ROOT_PEM) ? readFileSync(process.env.ICP_ROOT_PEM, 'utf8') : null
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function oidcToken() {
  const url = `${process.env.ACTIONS_ID_TOKEN_REQUEST_URL}&audience=onion-cost`
  const r = await fetch(url, { headers: { Authorization: `bearer ${process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN}` } })
  if (!r.ok) throw new Error(`OIDC HTTP ${r.status}`)
  return (await r.json()).value
}

async function callFn(token, body) {
  const r = await fetch(FN, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: ANON_KEY, 'x-github-oidc': token },
    body: JSON.stringify(body),
  })
  const out = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error(out.error ?? `função respondeu HTTP ${r.status}`)
  return out
}

function envelope(cnpj, uf, ult) {
  const nsu = String(ult).padStart(15, '0')
  return '<?xml version="1.0" encoding="utf-8"?>' +
    '<soap12:Envelope xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:soap12="http://www.w3.org/2003/05/soap-envelope">' +
    '<soap12:Body><nfeDistDFeInteresse xmlns="http://www.portalfiscal.inf.br/nfe/wsdl/NFeDistribuicaoDFe"><nfeDadosMsg>' +
    `<distDFeInt xmlns="http://www.portalfiscal.inf.br/nfe" versao="1.01"><tpAmb>1</tpAmb><cUFAutor>${UF[uf]}</cUFAutor>` +
    `<CNPJ>${cnpj}</CNPJ><distNSU><ultNSU>${nsu}</ultNSU></distNSU></distDFeInt>` +
    '</nfeDadosMsg></nfeDistDFeInteresse></soap12:Body></soap12:Envelope>'
}

function sefaz(job, ult) {
  return new Promise((resolve, reject) => {
    const payload = Buffer.from(envelope(job.cnpj, job.uf, ult), 'utf8')
    const req = https.request({
      host: 'www1.nfe.fazenda.gov.br',
      path: '/NFeDistribuicaoDFe/NFeDistribuicaoDFe.asmx',
      method: 'POST',
      cert: job.cert,
      key: job.key,
      agent: false,
      maxVersion: 'TLSv1.2', // a SEFAZ (IIS) pede o certificado por renegociação
      timeout: 40_000,
      headers: {
        'Content-Type': 'application/soap+xml; charset=utf-8; action="http://www.portalfiscal.inf.br/nfe/wsdl/NFeDistribuicaoDFe/nfeDistDFeInteresse"',
        'Content-Length': payload.length,
      },
    }, (res) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8')
        if (res.statusCode === 403) return reject(new Error('a SEFAZ recusou o certificado (HTTP 403)'))
        if (res.statusCode !== 200 && !body.includes('retDistDFeInt')) {
          return reject(new Error(`HTTP ${res.statusCode}: ${body.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200)}`))
        }
        resolve(body)
      })
    })
    req.on('timeout', () => req.destroy(new Error('tempo esgotado')))
    req.on('error', reject)
    req.end(payload)
  })
}


/** Pedido HTTPS com o certificado da empresa (Node/OpenSSL aceita a renegociação TLS da SEFAZ). */
function request(job, { host, path, method = 'GET', headers = {}, body }) {
  return new Promise((resolve, reject) => {
    const payload = body ? Buffer.from(body, 'utf8') : null
    const req = https.request({
      host, path, method, cert: job.cert, key: job.key, agent: false, maxVersion: 'TLSv1.2', timeout: 40_000,
      ...(host === NFCE_HOST && ICP_PEM ? { ca: [...tls.rootCertificates, ICP_PEM] } : {}),
      headers: { ...headers, ...(payload ? { 'Content-Length': payload.length } : {}) },
    }, (res) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }))
    })
    req.on('timeout', () => req.destroy(new Error('tempo esgotado')))
    req.on('error', reject)
    req.end(payload ?? undefined)
  })
}

/** Lê o WSDL do serviço da SEFAZ-SP para montar o envelope SOAP exatamente como ele espera. */
const wsdlCache = {}
async function nfceService(job, svc) {
  if (wsdlCache[svc]) return wsdlCache[svc]
  const r = await request(job, { host: NFCE_HOST, path: `/ws/${svc}.asmx?wsdl` })
  if (r.status !== 200) throw new Error(`WSDL ${svc}: HTTP ${r.status}`)
  const w = r.body
  const tns = w.match(/<(?:wsdl:)?definitions[^>]*targetNamespace="([^"]+)"/)?.[1]
  const soap12 = /soap12:binding/.test(w)
  const action = (soap12 ? w.match(/<soap12:operation[^>]*soapAction="([^"]*)"/) : w.match(/<soap:operation[^>]*soapAction="([^"]*)"/))?.[1] ?? ''
  const part = w.match(/<(?:wsdl:)?part[^>]*element="(?:\w+:)?(\w+)"/)?.[1] ?? 'nfeDadosMsg'
  let inner = null
  if (part !== 'nfeDadosMsg') {
    const el = w.match(new RegExp(`<(?:s|xs|xsd):element name="${part}"[\\s\\S]*?<(?:s|xs|xsd):element[^>]*name="(\\w+)"`))
    inner = el?.[1] ?? 'nfeDadosMsg'
  }
  const svcInfo = { tns, soap12, action, part, inner }
  console.log(`::notice title=${svc}::tns=${tns} soap12=${soap12} action=${action} corpo=${part}${inner ? '>' + inner : ''}`)
  return (wsdlCache[svc] = svcInfo)
}

async function nfceCall(job, svc, payload) {
  const s = await nfceService(job, svc)
  const content = s.inner ? `<${s.part} xmlns="${s.tns}"><${s.inner}>${payload}</${s.inner}></${s.part}>` : `<${s.part} xmlns="${s.tns}">${payload}</${s.part}>`
  const env = s.soap12
    ? `<?xml version="1.0" encoding="utf-8"?><soap12:Envelope xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:soap12="http://www.w3.org/2003/05/soap-envelope"><soap12:Body>${content}</soap12:Body></soap12:Envelope>`
    : `<?xml version="1.0" encoding="utf-8"?><soap:Envelope xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body>${content}</soap:Body></soap:Envelope>`
  const headers = s.soap12
    ? { 'Content-Type': `application/soap+xml; charset=utf-8; action="${s.action}"` }
    : { 'Content-Type': 'text/xml; charset=utf-8', SOAPAction: `"${s.action}"` }
  const r = await request(job, { host: NFCE_HOST, path: `/ws/${svc}.asmx`, method: 'POST', headers, body: env })
  if (r.status === 403) throw new Error('a SEFAZ-SP recusou o certificado (HTTP 403)')
  if (r.status !== 200 && !/retNfce/.test(r.body)) {
    throw new Error(`HTTP ${r.status}: ${r.body.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200)}`)
  }
  return r.body
}

const NFE_NS = 'http://www.portalfiscal.inf.br/nfe'

async function syncNfce(token, job, i) {
  let listed = 0
  let downloaded = 0
  if (job.nfce.list) {
    let cursor = job.nfce.cursor
    try {
      for (let n = 0; n < 15; n++) {
        const response = await nfceCall(job, 'NFCeListagemChaves',
          `<nfceListagemChaves versao="1.00" xmlns="${NFE_NS}"><tpAmb>1</tpAmb><dataHoraInicial>${cursor}</dataHoraInicial></nfceListagemChaves>`)
        const r = await callFn(token, { action: 'nfce-list-ingest', company_id: job.company_id, cursor, response })
        listed += r.keys ?? 0
        if (r.done || r.stop) break
        cursor = r.cursor
        await sleep(2000)
      }
    } catch (e) {
      console.log(`empresa ${i + 1}: erro na listagem de NFC-e - ${e.message}`)
      await callFn(token, { action: 'nfce-list-ingest', company_id: job.company_id, error: e.message }).catch(() => {})
      return
    }
    // chaves novas para baixar nesta mesma execução
    if (!job.nfce.downloads.length) {
      const again = (await callFn(token, { action: 'sync-jobs' })).jobs.find((j) => j.company_id === job.company_id)
      job.nfce.downloads = again?.nfce?.downloads ?? []
    }
  }
  // Até 3 lotes de 20 XMLs por execução; para se a SEFAZ-SP pedir para aguardar
  let downloads = job.nfce.downloads
  for (let lote = 0; lote < 3 && downloads.length; lote++) {
    let stop = false
    for (const chave of downloads) {
      try {
        const response = await nfceCall(job, 'NFCeDownloadXML',
          `<nfceDownloadXML versao="1.00" xmlns="${NFE_NS}"><tpAmb>1</tpAmb><chNFCe>${chave}</chNFCe></nfceDownloadXML>`)
        const r = await callFn(token, { action: 'nfce-xml-ingest', company_id: job.company_id, chave, response })
        if (r.ok) downloaded++
        if (r.stop) { stop = true; break }
      } catch (e) {
        await callFn(token, { action: 'nfce-xml-ingest', company_id: job.company_id, chave, error: e.message }).catch(() => {})
      }
      await sleep(2000)
    }
    if (stop || downloads.length < 20) break
    const again = (await callFn(token, { action: 'sync-jobs' })).jobs.find((j) => j.company_id === job.company_id)
    downloads = again?.nfce?.downloads ?? []
  }
  console.log(`empresa ${i + 1}: NFC-e ${listed} chave(s) listada(s), ${downloaded} XML(s) baixado(s)`)
}

const token = await oidcToken()
const { jobs } = await callFn(token, { action: 'sync-jobs' })
console.log(`${jobs.length} empresa(s) para sincronizar`)
let failures = 0
for (const [i, job] of jobs.entries()) {
  if (job.nfe) {
    let ult = job.nfe.last_nsu
    let total = 0
    try {
      for (let n = 0; n < MAX_CALLS; n++) {
        const response = await sefaz(job, ult)
        const r = await callFn(token, { action: 'sync-ingest', company_id: job.company_id, response })
        total += r.fetched ?? 0
        if (r.done) break
        ult = r.ult_nsu
      }
      console.log(`empresa ${i + 1}: NF-e ${total} documento(s) novo(s)`)
    } catch (e) {
      failures++
      console.log(`empresa ${i + 1}: erro nas NF-e - ${e.message}`)
      await callFn(token, { action: 'sync-ingest', company_id: job.company_id, error: e.message }).catch(() => {})
    }
  }
  if (job.nfce && (job.nfce.list || job.nfce.downloads.length)) await syncNfce(token, job, i)
}
if (failures) console.log(`::warning::${failures} empresa(s) com erro; veja a mensagem no app`)
