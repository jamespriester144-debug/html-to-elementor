# html-to-elementor

Projeto Next.js com TypeScript e Tailwind para converter HTML em JSON importavel pelo Elementor, bloquear download ate pagamento e persistir conversoes no Supabase.

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
- `/upload` aceita arquivo `.html` ou HTML colado.
- `/api/convert` converte com Cheerio e salva no Supabase com status `pending`.
- `/preview/[id]` mostra a previa do HTML.
- `/checkout/[id]` abre a etapa de pagamento.
- `/api/checkout` cria uma Stripe Checkout Session de US$9.90.
- `/api/webhook/stripe` escuta `checkout.session.completed` e marca a conversao como `paid`.
- `/download/[id]` e `/api/download/[id]` liberam o JSON apenas quando o status e `paid`.
