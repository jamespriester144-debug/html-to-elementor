# Lovable to Elementor

Projeto Next.js com TypeScript e Tailwind para converter sites Lovable baixados do GitHub em JSON importavel pelo Elementor. O fluxo salva a conversao no Supabase, mostra a previa e libera o download somente apos pagamento aprovado no Stripe.

O pipeline atual usa a `converter-v3`, que tenta preservar a fidelidade visual antes de liberar o template. Isso inclui captura real em browser, validacao visual por viewport, auditoria de tema, verificacao de assets criticos e fallback automatico entre modos de exportacao.

## Configuracao

1. Instale as dependencias:

```bash
npm install
```

2. Copie `.env.example` para `.env.local` e preencha as chaves do Supabase e Stripe. As flags de fidelidade visual e debug tambem ficam nesse arquivo.

3. Rode o SQL em `supabase/schema.sql` no Supabase.

4. Inicie o app:

```bash
npm run dev
```

## Fluxo

- `/` apresenta o produto.
- `/upload` aceita HTML exportado ou ZIP com `index.html`.
- `/api/convert` resolve a origem, renderiza a pagina em browser, roda a `converter-v3`, exige snapshot/pixel-perfect com similaridade minima de 99% e so entao persiste a conversao no Supabase.
- `/api/convert-v3` expoe a mesma pipeline visual em modo de inspecao, retornando `selectedMode`, `emittedMode`, `report`, `snapshot`, `contentIntegrity` e caminhos dos artefatos.
- `/preview/[id]` mostra a previa do site enviado.
- `/checkout/[id]` abre a etapa de pagamento.
- `/api/checkout` cria uma Stripe Checkout Session de US$9.90.
- `/api/webhook/stripe` escuta `checkout.session.completed` e marca a conversao como `paid`.
- `/download/[id]` e `/api/download/[id]` liberam o template Elementor apenas quando o status e `paid`.

## Como preparar um projeto Lovable

1. Baixe o projeto pelo GitHub.
2. Rode `npm install` dentro do projeto baixado.
3. Rode `npm run build`.
4. Compacte a pasta final que contem `index.html`, normalmente `dist`.
5. Envie esse ZIP em `/upload`.

## Visual Fidelity Mode

O pipeline trabalha com dois conceitos diferentes:

- `selectedMode`: o modo que a analise escolhe antes da exportacao final.
- `emittedMode`: o modo que realmente saiu depois dos fallbacks, auditorias e bloqueios.

Os modos publicos sao:

| Modo | Quando costuma ser escolhido | O que prioriza |
| --- | --- | --- |
| `editable` | DOM simples, poucos overlays, pouca sobreposicao, sem sinais fortes de risco visual | Maxima editabilidade no Elementor |
| `hybrid` | Layout com grids, elementos absolutos, cards, overlays ou widgets que pedem HTML preservado | Equilibrio entre edicao e fidelidade |
| `snapshot` | Site Lovable-like, assets criticos, `FORCE_VISUAL_SNAPSHOT`, `FORCE_FULL_PAGE_SNAPSHOT` ou risco visual alto | Aparencia validada por screenshot |
| `pixel-perfect` | Ultimo fallback quando o visual nao fecha em `editable`, `hybrid` ou `snapshot`, ou quando snapshot full-page nao pode ser emitido | Preservacao total via iframe/HTML congelado |

### Como a decisao e tomada

1. A captura gera `dom-snapshot`, `style-snapshot`, `box-snapshot`, screenshots por viewport e um `inputAnalysis`.
2. O analisador de complexidade calcula um score usando grids, `absolute/fixed/sticky`, overlays, cards, grupos sobrepostos e volume de nos.
3. Esse score escolhe um `selectedMode` inicial:
   - layouts simples ficam em `editable`
   - layouts medianos sobem para `hybrid`
   - layouts com muita sobreposicao/overlay/risco estrutural sobem para `pixel-perfect`
4. Antes de exportar, a pipeline pode promover o modo para `snapshot` quando qualquer uma destas condicoes acontece:
   - `FORCE_VISUAL_SNAPSHOT=true`
   - `FORCE_FULL_PAGE_SNAPSHOT=true`
   - a politica Lovable-like prefere snapshot para preservar a aparencia
   - a captura detecta falhas criticas de asset, como `hero background missing` ou `card image missing`
5. O exportador tenta candidatos em ordem, ate um passar na auditoria visual:

| Contexto | Ordem de tentativa |
| --- | --- |
| Browser + `selectedMode=editable` | `editable -> hybrid -> geometry -> snapshot -> pixel-perfect` |
| Browser + `selectedMode=hybrid` | `hybrid -> geometry -> snapshot -> pixel-perfect` |
| Browser + `selectedMode=snapshot` | `snapshot -> pixel-perfect` |
| Browser + `selectedMode=pixel-perfect` | `hybrid -> geometry -> snapshot -> pixel-perfect` |
| Sem browser real | `editable/hybrid/geometry -> pixel-perfect` (sem snapshot confiavel) |

6. O emissor `editable` pode terminar como `hybrid` se precisar preservar partes do DOM em widget HTML para manter a fidelidade.
7. Quando o modo final e `snapshot`, a estrategia tenta nesta ordem:
   - snapshot por secao
   - recaptura da secao com bounding box maior
   - snapshot visual puro da secao
   - snapshot responsivo da pagina inteira
   - `pixel-perfect`, se o full-page snapshot nao puder ser gerado com seguranca

### Flags uteis

| Variavel | Padrao | Efeito |
| --- | --- | --- |
| `FORCE_VISUAL_SNAPSHOT` | `true` | Faz snapshot visual ser o caminho principal sempre que houver captura em browser |
| `FORCE_FULL_PAGE_SNAPSHOT` | `false` | Obriga a pagina inteira a sair em snapshot responsivo |
| `UNIVERSAL_INPUT_ANALYSIS` | `false` | Mantem a analise universal ligada para armar snapshot como fallback seguro sem virar modo principal por padrao |
| `SAFE_FULL_PAGE_FALLBACK` | `false` | Mantem o full-page snapshot preparado como fallback mesmo quando a saida estrutural continua primaria |
| `VISUAL_DEBUG` | `false` | Copia imagens/diffs/per-section debug para a pasta da conversao |
| `DEBUG_CONVERSION` | `false` | Gera um bundle extra em `debug/conversions/...` com screenshots, elementos perdidos e relatorio de conversao |

## Logs e Debug Visual

Para depurar conversoes ruins, o caminho mais util costuma ser ligar as duas flags abaixo:

```bash
VISUAL_DEBUG=true
DEBUG_CONVERSION=true
```

Com isso, alem dos relatorios JSON, a pipeline passa a materializar os arquivos visuais usados na auditoria. O lugar mais confiavel para descobrir todos os caminhos e o proprio payload/relatorio retornado pela API:

- `artifacts.capture`
- `artifacts.export`
- `snapshot.visualValidationReport.viewportResults`
- `report.visualIssues`
- `contentIntegrity.debugArtifacts`

O diretorio base da conversao e `capture.artifacts.outputDir`. Por padrao ele fica em:

```text
.tmp/converter-v3/<resolved-source-id>/
```

Os testes e o script de aprendizado podem sobrescrever esse `outputRoot`. Exemplos reais:

- `os.tmpdir()/html-to-elementor-v3-*` nas suites de teste
- `debug/conversions/learning/<resolved-source-id>/` no script `learn:converter:v3`

## Onde encontrar os artefatos

Use `capture.artifacts.outputDir` como fonte da verdade. Os nomes abaixo sao os que o codigo escreve hoje.

| Artefato | Onde fica | Observacoes |
| --- | --- | --- |
| Screenshot original | `<outputDir>/screenshot-desktop.png`, `<outputDir>/screenshot-tablet.png`, `<outputDir>/screenshot-mobile.png` | So existe quando a captura rodou em browser real |
| Screenshot convertido | `artifacts.export.convertedScreenshotPath` ou `snapshot.convertedScreenshotPath` | Em snapshot puro costuma virar `<outputDir>/snapshot-preview.png` |
| Diff | `snapshot.visualValidationReport.viewportResults[].diffScreenshotPath` e `report.visualIssues[].diffScreenshotPath` | O caminho e carregado no relatorio mesmo quando o nome do arquivo varia por viewport/modo |
| `dom-snapshot.json` | `<outputDir>/dom-snapshot.json` | Estrutura DOM capturada |
| `style-snapshot.json` | `<outputDir>/style-snapshot.json` | Computed styles por no |
| `box-snapshot.json` | `<outputDir>/box-snapshot.json` | Bounding boxes por no |
| `visual-validation-report.json` | `<outputDir>/visual-validation-report.json` | Relatorio detalhado do snapshot/fallback visual |
| Relatorio final de validacao visual | `artifacts.export.visualValidationReportPath` | Hoje sai como `visual-validation-report-<arquivo>.json` |
| `content-integrity-report.json` | `<outputDir>/content-integrity-report.json` | Verifica se texto, imagens, links e secoes chegaram ao output |

Quando `VISUAL_DEBUG=true`, a pasta da conversao tambem ganha copias com nomes estaveis:

- `original-full-page.png`
- `converted-full-page.png`
- `full-page-diff.png`
- `<section-node-id>-original.png`
- `<section-node-id>-converted.png`
- `<section-node-id>-diff.png`
- `<section-node-id>-debug.json`

Quando `DEBUG_CONVERSION=true`, a pipeline tambem cria um bundle separado em `debug/conversions/<titulo>-<id>/` com:

- `original-screenshot.png`
- `converted-screenshot.png`
- `extracted-elements.json`
- `detected-sections.json`
- `lost-elements.json`
- `conversion-report.json`

## Como interpretar erros comuns

| Erro / sinal | O que significa | Onde olhar primeiro |
| --- | --- | --- |
| `theme mismatch` / `dark theme lost` | O original foi detectado como tema escuro, mas a previa convertida virou clara ou perdeu contraste/superficies escuras | `report.themeAudit`, `report.themeLogs`, `visual-validation-report*.json` |
| `hero overlay missing` | A hero perdeu overlay, gradient ou camada visual sobre o background | `report.visualIssues`, `<section-node-id>-debug.json`, diff da hero |
| `default button style detected` | O original tinha botoes claramente estilizados, mas a previa final parece botao default/browser | `report.themeAudit.issues`, `report.themeLogs`, preview convertido |
| `default input style detected` | Inputs/textareas/selects perderam fundo, borda, radius ou styling esperado | `report.themeAudit.issues`, `report.themeLogs`, preview convertido |
| `card background mismatch` | Cards perderam shell visual, como background, radius, sombra ou borda | `report.themeAudit`, `report.visualIssues`, `<section-node-id>-debug.json` |
| `asset missing` | Um asset importante nao carregou ou sumiu no output. Pode aparecer como `background asset missing`, `important image missing`, `hero background missing`, `card image missing` ou `asset failed` | `capture.inputAnalysis.diagnostics.resources`, `report.visualLogs`, diff do viewport |

### Leitura pratica

- Se o problema aparece em `themeAudit`, a estrutura saiu, mas o styling ficou longe do original.
- Se o problema aparece em `visualIssues` com `bbox`, use o `diffScreenshotPath` para localizar a perda no viewport.
- Se o problema aparece em `contentIntegrity.failureStage`, a exportacao foi bloqueada porque texto/imagem/link/secao sumiu do output final.
- Se `capture.renderer !== "browser"`, a pipeline perdeu a base necessaria para snapshot confiavel e tende a bloquear ou cair para `pixel-perfect`.
- Se `relativeAssetsResolved=false` ou ha itens `failed` em `assetsLoaded/resources`, corrija caminho de CSS/imagem/fonte antes de culpar o emissor do Elementor.

## Como testar uma conversao Lovable

Fixtures Lovable ja existentes:

- `tests/fixtures/sites/lovable-export.html`
- `tests/fixtures/sites/lovable-alt-layout.html`
- `tests/fixtures/sites/lovable-editorial-layout.html`

Fluxo recomendado:

1. Validar a resolucao de um projeto Lovable (CSS inline, fontes, icons e assets):

```bash
npx tsx tests/lovable-rendering.test.ts
```

2. Rodar a suite principal da `converter-v3`:

```bash
npm run test:converter:v3
```

3. Rodar uma conversao Lovable isolada com artefatos de aprendizado/debug:

```bash
npm run learn:converter:v3 -- --input tests/fixtures/sites/lovable-export.html --tag lovable --tag responsive --min-similarity 0.99
```

4. Se quiser inspecionar a resposta bruta da pipeline, suba o app com `npm run dev` e envie o HTML/ZIP para `/api/convert-v3` ou pela UI em `/upload`. Em erros `422`, os campos `report`, `snapshot`, `contentIntegrity` e `artifacts` ja trazem o mapa de depuracao.

## Como adicionar fixtures de teste

Voce tem dois caminhos.

### 1. Fixture fixo na matriz principal

Use esse caminho quando o caso precisa virar cobertura permanente do repositorio.

1. Adicione o HTML em `tests/fixtures/sites/`.
2. Se houver assets locais, coloque-os em `tests/fixtures/sites/assets/...`.
3. Registre o caso em `tests/support/converter-v3-fixture-matrix.ts` com:
   - `name`
   - `tags`
   - `preferBrowser`
   - `verifyExport`
   - `assertResult`
4. Rode:

```bash
npm run test:converter:v3
```

Tags aceitas hoje:

- `lovable`
- `generic-static`
- `react-export`
- `layout-stress`
- `asset-coverage`
- `responsive`
- `long-form`

### 2. Fixture aprendido pela pipeline

Use esse caminho quando quiser promover um caso real para a suite universal sem editar a matriz principal manualmente.

```bash
npm run learn:converter:v3 -- --input C:\caminho\para\meu-site.html --tag lovable --tag responsive --promote-fixture --fixture-name meu-site.html --min-similarity 0.99
```

Esse comando:

- roda a pipeline com `preferBrowser: true`
- grava artefatos em `debug/conversions/learning/<resolved-source-id>/`
- copia o fixture para `tests/fixtures/sites/learned/meu-site.html`
- atualiza `tests/support/converter-v3-learned-fixtures.json`
- faz a suite universal carregar o novo fixture automaticamente no proximo `npm run test:converter:v3`

Se o site nao atingir a similaridade minima ou falhar em integridade de conteudo, o comando sai com erro e o fixture nao deve ser promovido.
