// Intermediário para a SEFAZ (Vercel, Node.js).
// A SEFAZ pede o certificado do cliente no meio da conexão (renegociação TLS),
// algo que o Node/OpenSSL faz e o ambiente do Supabase não. Esta função só repassa
// o pedido SOAP com o certificado e devolve a resposta; não guarda nada.
//
// POST /api/sefaz   cabeçalho x-proxy-secret: <PROXY_SECRET>
// corpo JSON: { cert: PEM, key: PEM, xml: envelope SOAP }
// resposta:   { status, body }

const https = require('node:https')
const crypto = require('node:crypto')

const HOST = process.env.SEFAZ_TEST_HOST || 'www1.nfe.fazenda.gov.br'
const PORT = Number(process.env.SEFAZ_TEST_PORT || 443)
const PATH = '/NFeDistribuicaoDFe/NFeDistribuicaoDFe.asmx'
const ACTION = 'http://www.portalfiscal.inf.br/nfe/wsdl/NFeDistribuicaoDFe/nfeDistDFeInteresse'

function sameSecret(a, b) {
  const x = Buffer.from(String(a ?? ''))
  const y = Buffer.from(String(b ?? ''))
  return x.length === y.length && x.length > 0 && crypto.timingSafeEqual(x, y)
}

function readBody(req) {
  if (req.body && typeof req.body === 'object') return Promise.resolve(req.body)
  return new Promise((resolve, reject) => {
    let data = ''
    req.on('data', (c) => { data += c; if (data.length > 2_000_000) reject(new Error('corpo grande demais')) })
    req.on('end', () => { try { resolve(JSON.parse(data || '{}')) } catch (e) { reject(e) } })
    req.on('error', reject)
  })
}

function post({ cert, key, xml }) {
  return new Promise((resolve, reject) => {
    const payload = Buffer.from(xml, 'utf8')
    const req = https.request({
      host: HOST,
      port: PORT,
      servername: HOST,
      path: PATH,
      method: 'POST',
      cert,
      key,
      agent: false,
      // TLS 1.2: a SEFAZ (IIS) pede o certificado por renegociação
      maxVersion: 'TLSv1.2',
      timeout: 40_000,
      headers: {
        'Content-Type': `application/soap+xml; charset=utf-8; action="${ACTION}"`,
        'Content-Length': payload.length,
        'User-Agent': 'OnionCost/1.0',
      },
    }, (res) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }))
      res.on('error', reject)
    })
    req.on('timeout', () => req.destroy(new Error('tempo esgotado falando com a SEFAZ')))
    req.on('error', reject)
    req.end(payload)
  })
}

module.exports = async (req, res) => {
  res.setHeader('Content-Type', 'application/json')
  if (req.method !== 'POST') {
    res.statusCode = 405
    return res.end(JSON.stringify({ error: 'Use POST' }))
  }
  if (!process.env.PROXY_SECRET || !sameSecret(req.headers['x-proxy-secret'], process.env.PROXY_SECRET)) {
    res.statusCode = 401
    return res.end(JSON.stringify({ error: 'não autorizado' }))
  }
  try {
    const { cert, key, xml } = await readBody(req)
    if (!cert || !key || !xml) throw new Error('faltam cert, key ou xml')
    const out = await post({ cert, key, xml })
    res.statusCode = 200
    res.end(JSON.stringify(out))
  } catch (e) {
    res.statusCode = 502
    res.end(JSON.stringify({ error: `${e?.code ? e.code + ': ' : ''}${e?.message ?? e}` }))
  }
}
