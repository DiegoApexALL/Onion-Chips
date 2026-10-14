// Teste do leitor de fechamento: bun scripts/fechamento.test.ts
import { conferencia, matchUnidade, money, parseFechamento, quebra, totalDelivery, type Unidade } from '../src/lib/fechamento'

const texto = `Claro! Aqui está o fechamento:

**#FECHAMENTO ONION COST**
**UNIDADE:** ONION CHIPS ARAÇA
CNPJ: 62.014.797
DATA: 12/10/2026
ABERTURA: 12/10/2026 18:31
FECHAMENTO: 12/10/2026 23:56
RESPONSAVEL: ANDRÉ
VENDAS QTD: 30
VENDAS TOTAL: R$ 5.764,92
VALOR ABERTURA: 243,20
SISTEMA DINHEIRO: 1.000,80
SISTEMA DÉBITO: 642,04
SISTEMA CRÉDITO: 975,53
SISTEMA OUTROS: 2.549,70
SISTEMA PIX: 578,85
CONTADO DINHEIRO: 1.033,80
CONTADO DÉBITO: 651,04
CONTADO CRÉDITO: 975,53
CONTADO OUTROS: 2.549,70
CONTADO PIX: 579,36
- MAQUININHA SUMUP: DÉBITO 372,60; CRÉDITO 939,75; PIX 579,36
- MAQUININHA PAGBANK: DÉBITO 278,44; CRÉDITO 35,78; PIX 0
DELIVERY IFOOD: 26 PEDIDOS; 1.842,38
DELIVERY KEETA: 9 PEDIDOS; 866,54
DELIVERY BYFOOD: 1 PEDIDO; 129,00
DESPESA: nenhuma; 0
REPASSE: 1.050,00
TROCO: 227,00
#FIM`

let falhas = 0
const ok = (c: unknown, m: string) => { if (c) console.log('ok', m); else { falhas++; console.error('FALHOU', m) } }

ok(money('R$ 1.033,80') === 1033.8 && money('1033.80') === 1033.8 && money('1.050') === 1050 && money('-9,00') === -9, 'money')
const { fechamento: f, avisos } = parseFechamento(texto)
ok(avisos.length === 0, `sem avisos ${JSON.stringify(avisos)}`)
ok(f.data === '2026-10-12' && f.abertura_at === '2026-10-12T18:31' && f.fechamento_at === '2026-10-12T23:56', 'datas')
ok(f.vendas_qtd === 30 && f.vendas_total === 5764.92 && f.valor_abertura === 243.2, 'vendas')
ok(f.sistema.dinheiro === 1000.8 && f.sistema.debito === 642.04 && f.sistema.pix === 578.85, 'sistema')
ok(f.contado.dinheiro === 1033.8 && f.contado.debito === 651.04 && f.contado.pix === 579.36, 'contado')
ok(f.maquininhas.length === 2 && f.maquininhas[0].credito === 939.75 && f.maquininhas[1].debito === 278.44, 'maquininhas')
ok(f.delivery.length === 3 && f.delivery[0].pedidos === 26 && totalDelivery(f) === 2837.92, 'delivery')
ok(f.despesas.length === 0 && f.repasse === 1050 && f.troco === 227, 'repasse/troco')
ok(quebra(f) === 42.51, `quebra ${quebra(f)}`)
const c = Object.fromEntries(conferencia(f).map((l) => [l.item, l.diferenca]))
console.log(c)
ok(c['Dinheiro (sistema × contado)'] === 33 && c['Débito (sistema × contado)'] === 9 && c['Pix (sistema × contado)'] === 0.51, 'diferenças')
ok(c['Débito (contado × maquininhas)'] === 0 && c['Crédito (contado × maquininhas)'] === 0 && c['Pix (contado × maquininhas)'] === 0, 'maquininhas batem')
ok(c['Vendas × formas de pagamento (PDV)'] === -18, 'vendas × pagamentos')
ok(c['Gaveta (abertura + dinheiro × repasse + troco + despesas)'] === 0, 'gaveta')
const unidades: Unidade[] = [
  { id: 'a', nome: 'Onion Araçá', cidade: 'Araçatuba', apelidos: 'ARACA, MARIO COVAS', company_id: null },
  { id: 'b', nome: 'Onion Andradina', cidade: 'Andradina', apelidos: null, company_id: 'x', cnpj: '45215546000106' },
]
ok(matchUnidade(unidades, f, texto)?.id === 'a', 'unidade por nome')
ok(matchUnidade(unidades, { ...f, unidade_texto: 'loja', cnpj: '45215546000106' })?.id === 'b', 'unidade por CNPJ')
if (falhas) process.exit(1)
