// Sincronização com a SEFAZ (NFeDistribuicaoDFe), rodando no GitHub Actions.
// Pede à função "nfe" do Supabase as empresas pendentes, consulta a SEFAZ com o certificado
// de cada uma (Node/OpenSSL aceita a renegociação TLS que a SEFAZ usa) e devolve as respostas.
// Nada sensível é impresso no log (o repositório é público).
import https from 'node:https'
import { readFileSync } from 'node:fs'

const config = readFileSync(new URL('../src/lib/config.ts', import.meta.url), 'utf8')
const SUPABASE_URL = config.match(/SUPABASE_URL = '([^']+)'/)[1]
const ANON_KEY = config.match(/SUPABASE_ANON_KEY = '([^']+)'/)[1]
const FN = `${SUPABASE_URL}/functions/v1/nfe`

const UF = { RO: 11, AC: 12, AM: 13, RR: 14, PA: 15, AP: 16, TO: 17, MA: 21, PI: 22, CE: 23, RN: 24, PB: 25, PE: 26, AL: 27,
  SE: 28, BA: 29, MG: 31, ES: 32, RJ: 33, SP: 35, PR: 41, SC: 42, RS: 43, MS: 50, MT: 51, GO: 52, DF: 53 }
const MAX_CALLS = 20

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

const token = await oidcToken()
const { jobs } = await callFn(token, { action: 'sync-jobs' })
console.log(`${jobs.length} empresa(s) para sincronizar`)
let failures = 0
for (const [i, job] of jobs.entries()) {
  let ult = job.last_nsu
  let total = 0
  try {
    for (let n = 0; n < MAX_CALLS; n++) {
      const response = await sefaz(job, ult)
      const r = await callFn(token, { action: 'sync-ingest', company_id: job.company_id, response })
      total += r.fetched ?? 0
      if (r.done) break
      ult = r.ult_nsu
    }
    console.log(`empresa ${i + 1}: ${total} documento(s) novo(s)`)
  } catch (e) {
    failures++
    console.log(`empresa ${i + 1}: erro - ${e.message}`)
    await callFn(token, { action: 'sync-ingest', company_id: job.company_id, error: e.message }).catch(() => {})
  }
}
if (failures) console.log(`::warning::${failures} empresa(s) com erro; veja a mensagem no app`)
