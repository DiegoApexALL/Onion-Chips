// Testes da função "nfe". Rodam no GitHub Actions: deno test --allow-read --allow-env --allow-run supabase/functions/nfe
// Variáveis opcionais: TEST_PFX (caminho de um .pfx de teste) e TEST_PFX_PASSWORD.
import { assert, assertEquals, assertRejects, assertThrows } from 'jsr:@std/assert@1'
import { readPfx, UserError } from './cert.ts'
import * as s from './sefaz.ts'

async function gzipB64(text: string) {
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'))
  const bytes = new Uint8Array(await new Response(stream).arrayBuffer())
  return btoa(String.fromCharCode(...bytes))
}

Deno.test('envelope da consulta', () => {
  const env = s.buildEnvelope('12345678000199', 'SP', 42)
  assert(env.includes('<cUFAutor>35</cUFAutor>'))
  assert(env.includes('<CNPJ>12345678000199</CNPJ>'))
  assert(env.includes('<ultNSU>000000000000042</ultNSU>'))
  assertThrows(() => s.buildEnvelope('123', 'SP', 0))
})

Deno.test('lê o retorno da SEFAZ e os documentos', async () => {
  const res = '<resNFe xmlns="http://www.portalfiscal.inf.br/nfe"><chNFe>35261011111111000111550010000001231000001234</chNFe>' +
    '<CNPJ>11111111000111</CNPJ><xNome>Fornecedor &amp; Cia</xNome><dhEmi>2026-10-05T10:20:00-03:00</dhEmi><vNF>1500.50</vNF><cSitNFe>1</cSitNFe></resNFe>'
  const ev = '<resEvento><chNFe>35261011111111000111550010000001231000001234</chNFe><tpEvento>110111</tpEvento></resEvento>'
  const soap = '<soap:Envelope xmlns:soap="http://www.w3.org/2003/05/soap-envelope"><soap:Body><retDistDFeInt versao="1.01">' +
    '<cStat>138</cStat><xMotivo>Documento localizado</xMotivo><ultNSU>000000000000002</ultNSU><maxNSU>000000000000005</maxNSU><loteDistDFeInt>' +
    `<docZip NSU="000000000000001" schema="resNFe_v1.01.xsd">${await gzipB64(res)}</docZip>` +
    `<docZip NSU="000000000000002" schema="resEvento_1.01.xsd">${await gzipB64(ev)}</docZip>` +
    '</loteDistDFeInt></retDistDFeInt></soap:Body></soap:Envelope>'
  const ret = s.parseRet(soap)
  assertEquals([ret.cStat, ret.ultNSU, ret.maxNSU, ret.docs.length], [138, 2, 5, 2])
  const nfe = s.parseDoc(ret.docs[0].schema, await s.gunzipBase64(ret.docs[0].b64))
  assertEquals(nfe?.kind, 'nfe')
  if (nfe?.kind === 'nfe') {
    assertEquals(nfe.emit_nome, 'Fornecedor & Cia')
    assertEquals(nfe.valor, 1500.5)
    assertEquals(nfe.competencia, '2026-10')
  }
  assertEquals(s.parseDoc(ret.docs[1].schema, await s.gunzipBase64(ret.docs[1].b64))?.kind, 'cancel')
})

Deno.test('mês corrente no horário de Brasília', () => {
  assertEquals(s.currentMonth(new Date('2026-11-01T02:00:00Z')), '2026-10')
})

Deno.test('certificado A1 de teste', async () => {
  const path = Deno.env.get('TEST_PFX')
  if (!path) return console.log('TEST_PFX não definido: pulando')
  const pfx = btoa(String.fromCharCode(...await Deno.readFile(path)))
  const pem = readPfx(pfx, Deno.env.get('TEST_PFX_PASSWORD') ?? '')
  assert(pem.cert.includes('BEGIN CERTIFICATE'))
  assert(pem.key.includes('BEGIN PRIVATE KEY'))
  assertEquals(pem.cnpj, '12345678000199')
  assert(pem.notAfter.getTime() > Date.now())
  await assertRejects(async () => readPfx(pfx, 'senha-errada'), UserError)
})

Deno.test('NFC-e: listagem, download e datas', () => {
  const k1 = '35261045215546000106650010000012341000012345'
  const k2 = '35260945215546000106650010000012351000012346'
  const list = s.parseNfceList(`<soap:Envelope><soap:Body><retNfceListagemChaves versao="1.00" xmlns="http://www.portalfiscal.inf.br/nfe"><tpAmb>1</tpAmb><verAplic>SP</verAplic><dhReq>2026-10-14T15:00:00</dhReq><cStat>101</cStat><xMotivo>Parcial</xMotivo><chNFCe>${k1}</chNFCe><chNFCe>${k2}</chNFCe><dhEmisUltNfce>2026-10-02T11:30:15</dhEmisUltNfce></retNfceListagemChaves></soap:Body></soap:Envelope>`)
  assertEquals([list.cStat, list.chaves.length, list.dhEmisUltNfce], [101, 2, '2026-10-02T11:30:15'])
  assertEquals(s.competenciaFromKey(k1), '2026-10')
  assertEquals(s.competenciaFromKey(k2), '2026-09')
  const dl = s.parseNfceXml('<retNfceDownloadXML versao="1.00"><tpAmb>1</tpAmb><cStat>200</cStat><xMotivo>ok</xMotivo><proc><nfeProc versao="4.00"><dhInc>2026-10-02T11:30:20-03:00</dhInc><nProt>135260000000001</nProt><NFe><infNFe><ide><dhEmi>2026-10-02T11:30:15-03:00</dhEmi></ide><total><ICMSTot><vProd>10.00</vProd><vNF>12.50</vNF></ICMSTot></total></infNFe></NFe></nfeProc><procEventoNFe versao="1.00"><dhInc>x</dhInc><nProt>1</nProt><evento><infEvento><tpEvento>110111</tpEvento></infEvento></evento></procEventoNFe></proc></retNfceDownloadXML>')
  assertEquals([dl.cStat, dl.valor, dl.competencia, dl.cancelada], [200, 12.5, '2026-10', true])
  assertEquals(s.localMinute(new Date('2026-10-14T18:05:00Z')), '2026-10-14T15:05')
  assertEquals(s.fromLocal('2026-10-02T11:30:15').toISOString(), '2026-10-02T14:30:00.000Z')
})
