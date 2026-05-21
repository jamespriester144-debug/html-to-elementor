# Lovable to Elementor

Projeto Next.js com TypeScript e Tailwind para converter sites Lovable baixados do GitHub em JSON importavel pelo Elementor. O fluxo salva a conversao no Supabase, mostra a previa e libera o download somente apos pagamento aprovado no Stripe.

## Configuracao

1. Instale as dependencias:

```bash
npm install
```

2. Copie `.env.example` para `.env.local` e preencha as chaves do Supabase e Stripe.

3. Rode o SQL em `supabase/schema.sql` no Supabase.

4. Inicie o app:

```bash
npm run dev
```

## Fluxo

- `/` apresenta o produto.
- `/upload` aceita HTML exportado ou ZIP com `index.html`.
- `/api/convert` converte o build HTML do Lovable com Cheerio e salva no Supabase com status `pending`.
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
