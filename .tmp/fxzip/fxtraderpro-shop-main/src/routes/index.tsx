import { createFileRoute } from "@tanstack/react-router";
import { Check, Sparkles, Heart, Shield, Truck, Star, Plus, Minus } from "lucide-react";
import { useState } from "react";
import productImg from "@/assets/collagen/product.png";
import lifestyleImg from "@/assets/collagen/img-41.jpeg";
import skinImg from "@/assets/collagen/skin.png";
import healthImg from "@/assets/collagen/health.jpg";
import ingredientsImg from "@/assets/collagen/ingredients.jpg";
import paymentsImg from "@/assets/collagen/img-51.png";
import logoImg from "@/assets/collagen/brand-logo.png";

export const Route = createFileRoute("/")({
  component: Index,
  head: () => ({
    meta: [
      { title: "Advanced Collagen Plus — 5 Collagen Types from 4 Premium Sources" },
      {
        name: "description",
        content:
          "Advanced Collagen Plus combines 5 collagen types from 4 premium sources for firmer skin, stronger nails, healthier hair and joint flexibility.",
      },
    ],
    links: [
      { rel: "preconnect", href: "https://fonts.googleapis.com" },
      { rel: "preconnect", href: "https://fonts.gstatic.com", crossOrigin: "" },
      {
        rel: "stylesheet",
        href: "https://fonts.googleapis.com/css2?family=Playfair+Display:wght@500;600;700;800&family=Inter:wght@400;500;600;700&display=swap",
      },
    ],
  }),
});

const benefits = [
  "5 Collagen Types",
  "Firmer Skin",
  "Joint Support",
  "Strong Nails",
  "Healthy Hair",
];

const collagenTypes = [
  {
    types: "Types I & III",
    source: "Grass-Fed Bovine",
    desc: "Supports healthy skin and hair from within.",
  },
  {
    types: "Type II",
    source: "Pasture-Raised Chicken",
    desc: "Promotes joint health and flexibility.",
  },
  {
    types: "Type V",
    source: "Wild-Caught Marine",
    desc: "Supports nail strength and natural growth.",
  },
  {
    types: "Type X",
    source: "Organic Eggshell Membrane",
    desc: "Reinforces joint comfort and mobility.",
  },
];

const pillars = [
  {
    img: skinImg,
    tag: "Radiant Skin",
    title: "Visibly firmer, smoother skin",
    body:
      "Types I and III from grass-fed bovine help restore the elasticity and hydration your skin loses after your 20s — for that fresh, lit-from-within look.",
  },
  {
    img: healthImg,
    tag: "Active Health",
    title: "Move with ease, every day",
    body:
      "Type II chicken collagen and Type X eggshell membrane support cartilage, joint comfort and flexibility — so your pace is set by you, not your joints.",
  },
  {
    img: ingredientsImg,
    tag: "Premium Ingredients",
    title: "5 types. 4 sources. Zero compromise.",
    body:
      "Bovine, chicken, marine and eggshell collagens combined with a Biotin boost. No clumps, no off-tastes — dissolves perfectly in any hot or cold drink.",
  },
];

const reviews = [
  {
    name: "Karen O.",
    text:
      "I've used this collagen for 2 months and already see improvement in loose skin on arms and legs. Also, it dissolves in any liquid with no taste.",
  },
  {
    name: "Daniel L.",
    text:
      "Improved energy with greater range of motion and flexibility. My skin is not nearly as dry and appears much smoother. Mixes well without a bad taste.",
  },
  {
    name: "Pilar M.",
    text:
      "Not even a month in and I can feel the difference — my skin is more hydrated, less rough. I'm getting compliments about looking rejuvenated.",
  },
  {
    name: "Sarah D. C.",
    text:
      "Such success with Collagen Plus — increased range of motion in my right shoulder, and noticeably reduced discomfort. Nothing else worked like this.",
  },
];

const packages = [
  {
    label: "Sample",
    bags: 1,
    price: 49.95,
    total: 49.95,
    save: 0,
    freeShip: false,
  },
  {
    label: "Most Popular",
    bags: 3,
    price: 44.95,
    total: 134.85,
    save: 15,
    freeShip: true,
    highlight: true,
  },
  {
    label: "Biggest Savings",
    bags: 6,
    price: 41.5,
    total: 249.0,
    save: 50.7,
    freeShip: true,
  },
];

const faqs = [
  {
    q: "What types of collagen are in Advanced Collagen Plus?",
    a: "Five distinct types: I and III from grass-fed bovine, II from pasture-raised chicken, V from wild-caught marine, and X from organic eggshell membrane.",
  },
  {
    q: "What is the recommended serving size? How do I use it?",
    a: "One scoop per day mixed into any hot or cold beverage — coffee, tea, smoothies or simply water. It dissolves cleanly with no clumps.",
  },
  {
    q: "Is Advanced Collagen Plus hydrolyzed?",
    a: "Yes. The collagen is hydrolyzed into smaller peptides for optimal absorption by your body.",
  },
  {
    q: "Is it free of dairy, gluten, and soy?",
    a: "Yes — Advanced Collagen Plus is hormone-free, gluten-free and soy-free.",
  },
  {
    q: "Is Advanced Collagen Plus Non-GMO?",
    a: "Yes. We source only premium, non-GMO ingredients from trusted suppliers.",
  },
  {
    q: "How long until I see results?",
    a: "Many customers report visible skin and joint improvements within 4–8 weeks of consistent daily use.",
  },
  {
    q: "What does Advanced Collagen Plus taste like?",
    a: "Virtually nothing — it is unflavored and odorless, so it blends invisibly into whatever you mix it with.",
  },
];

function Index() {
  const [openFaq, setOpenFaq] = useState<number | null>(0);

  return (
    <div className="min-h-screen bg-background font-sans text-foreground" style={{ fontFamily: "var(--font-sans)" }}>
      {/* NAV */}
      <header className="sticky top-0 z-50 border-b border-border/60 bg-background/80 backdrop-blur-md">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-4">
          <a href="#top" className="flex items-center gap-2">
            <img src={logoImg} alt="Advanced Bionutritionals" className="h-14 w-auto md:h-16" />
          </a>
          <nav className="hidden items-center gap-8 text-sm font-medium text-muted-foreground md:flex">
            <a href="#about" className="hover:text-primary">About</a>
            <a href="#ingredients" className="hover:text-primary">Ingredients</a>
            <a href="#guarantee" className="hover:text-primary">Guarantee</a>
            <a href="#faq" className="hover:text-primary">FAQ</a>
          </nav>
          <a
            href="#order"
            className="rounded-full bg-primary px-5 py-2.5 text-sm font-semibold text-primary-foreground shadow-soft transition hover:bg-primary-deep"
          >
            Order Now
          </a>
        </div>
      </header>

      {/* HERO */}
      <section
        id="top"
        className="relative overflow-hidden"
        style={{ background: "var(--gradient-hero)" }}
      >
        <div className="absolute inset-0 opacity-30 [background:radial-gradient(circle_at_20%_30%,oklch(0.99_0.02_30)_0%,transparent_40%),radial-gradient(circle_at_80%_70%,oklch(0.85_0.15_15)_0%,transparent_50%)]" />
        <div className="relative mx-auto grid max-w-6xl gap-12 px-6 py-20 md:grid-cols-2 md:items-center md:py-28">
          <div>
            <div className="mb-6 flex items-center gap-3">
              <img src={logoImg} alt="Advanced Bionutritionals" className="h-20 w-auto md:h-24" />
              <span className="rounded-full bg-primary/10 px-3 py-1 text-xs font-semibold uppercase tracking-wider text-primary">
                New Formula
              </span>
            </div>
            <h1
              className="text-6xl font-semibold leading-[1.05] tracking-tight text-foreground md:text-7xl lg:text-8xl"
              style={{ fontFamily: "var(--font-display)" }}
            >
              Experience the{" "}
              <span className="bg-gradient-to-r from-primary to-primary-glow bg-clip-text text-transparent">
                Advanced Collagen Plus
              </span>{" "}
              difference.
            </h1>
            <p className="mt-6 max-w-lg text-lg leading-relaxed text-muted-foreground">
              5 collagen types from 4 premium sources. More joint flexibility, healthier
              skin, stronger hair &amp; nails — in one effortless daily scoop.
            </p>
            <div className="mt-8 flex flex-wrap items-center gap-4">
              <a
                href="#order"
                className="inline-flex items-center gap-2 rounded-full bg-primary px-7 py-4 text-base font-semibold text-primary-foreground shadow-elegant transition hover:translate-y-[-1px] hover:bg-primary-deep"
              >
                Order Now <Sparkles className="h-4 w-4" />
              </a>
              <div className="flex items-center gap-1 text-sm text-muted-foreground">
                <div className="flex">
                  {[...Array(5)].map((_, i) => (
                    <Star key={i} className="h-4 w-4 fill-gold text-gold" />
                  ))}
                </div>
                <span className="ml-2">4.6 · 70+ reviews</span>
              </div>
            </div>
            <ul className="mt-10 flex flex-wrap gap-x-6 gap-y-3">
              {benefits.map((b) => (
                <li key={b} className="flex items-center gap-2 text-sm font-medium text-foreground">
                  <Check className="h-4 w-4 text-primary" /> {b}
                </li>
              ))}
            </ul>
          </div>

          <div className="relative">
            <div className="absolute -inset-8 rounded-full bg-primary/20 blur-3xl" />
            <img
              src={productImg}
              alt="Advanced Collagen Plus bag with money-back guarantee"
              className="relative mx-auto w-full max-w-md drop-shadow-2xl"
              width={700}
              height={700}
            />
          </div>
        </div>
      </section>

      {/* WHY DECLINE */}
      <section id="about" className="bg-cream py-24">
        <div className="mx-auto grid max-w-6xl gap-14 px-6 md:grid-cols-2 md:items-center">
          <div>
            <span className="text-xs font-semibold uppercase tracking-[0.25em] text-primary">
              The Collagen Decline
            </span>
            <h2
              className="mt-3 text-4xl font-semibold leading-tight md:text-5xl"
              style={{ fontFamily: "var(--font-display)" }}
            >
              What happens to your body's collagen as you age?
            </h2>
            <p className="mt-6 text-lg leading-relaxed text-muted-foreground">
              Research suggests collagen levels start to decline gradually every year after
              your 20s. When you're young, levels are high — keeping skin smooth, hair full
              and nails strong. As they drop, skin loses its glow, hair feels thinner and
              nails get brittle.
            </p>
            <p className="mt-4 text-lg leading-relaxed text-muted-foreground">
              UV exposure, pollution, stress and modern diets accelerate the decline. Most
              people simply don't get enough collagen-rich foods anymore.
            </p>
          </div>
          <img
            src={lifestyleImg}
            alt="Active couple enjoying healthy lifestyle"
            loading="lazy"
            className="rounded-3xl shadow-elegant"
            width={300}
            height={300}
          />
        </div>
      </section>

      {/* THREE PILLARS — skin / health / ingredients */}
      <section id="ingredients" className="py-24">
        <div className="mx-auto max-w-6xl px-6">
          <div className="mx-auto max-w-2xl text-center">
            <span className="text-xs font-semibold uppercase tracking-[0.25em] text-primary">
              Designed For You
            </span>
            <h2
              className="mt-3 text-4xl font-semibold leading-tight md:text-5xl"
              style={{ fontFamily: "var(--font-display)" }}
            >
              One scoop. Three transformations.
            </h2>
          </div>

          <div className="mt-16 space-y-20">
            {pillars.map((p, i) => (
              <div
                key={p.title}
                className={`grid gap-10 md:grid-cols-2 md:items-center ${
                  i % 2 === 1 ? "md:[&>div:first-child]:order-2" : ""
                }`}
              >
                <div className="relative">
                  <div className="absolute -inset-4 rounded-3xl bg-primary/10 blur-2xl" />
                  <img
                    src={p.img}
                    alt={p.title}
                    loading="lazy"
                    className="relative aspect-square w-full rounded-3xl object-cover shadow-elegant"
                    width={1024}
                    height={1024}
                  />
                </div>
                <div>
                  <span className="inline-flex items-center gap-2 rounded-full bg-primary/10 px-4 py-1.5 text-xs font-semibold uppercase tracking-wider text-primary">
                    <Sparkles className="h-3 w-3" /> {p.tag}
                  </span>
                  <h3
                    className="mt-5 text-3xl font-semibold leading-tight md:text-4xl"
                    style={{ fontFamily: "var(--font-display)" }}
                  >
                    {p.title}
                  </h3>
                  <p className="mt-4 text-lg leading-relaxed text-muted-foreground">{p.body}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* COLLAGEN TYPES GRID */}
      <section className="bg-cream py-24">
        <div className="mx-auto max-w-6xl px-6">
          <div className="mx-auto max-w-2xl text-center">
            <span className="text-xs font-semibold uppercase tracking-[0.25em] text-primary">
              Comprehensive Supply
            </span>
            <h2
              className="mt-3 text-4xl font-semibold leading-tight md:text-5xl"
              style={{ fontFamily: "var(--font-display)" }}
            >
              Five collagen types. Four premium sources.
            </h2>
            <p className="mt-5 text-lg text-muted-foreground">
              Most powders give you one source. We combined the best of four — so every part
              of your body that needs collagen actually gets the right kind.
            </p>
          </div>

          <div className="mt-14 grid gap-6 md:grid-cols-2 lg:grid-cols-4">
            {collagenTypes.map((c) => (
              <div
                key={c.source}
                className="group rounded-3xl border border-border bg-card p-7 shadow-soft transition hover:-translate-y-1 hover:shadow-elegant"
              >
                <div
                  className="text-2xl font-semibold text-primary"
                  style={{ fontFamily: "var(--font-display)" }}
                >
                  {c.types}
                </div>
                <div className="mt-1 text-sm font-semibold uppercase tracking-wider text-foreground">
                  {c.source}
                </div>
                <p className="mt-4 text-sm leading-relaxed text-muted-foreground">{c.desc}</p>
              </div>
            ))}
          </div>

          <div className="mt-12 grid gap-4 rounded-3xl border border-primary/20 bg-card p-8 sm:grid-cols-3">
            <Feature icon={<Heart className="h-5 w-5" />} title="Beyond Skin Deep" body="With a Biotin boost for hair and nails." />
            <Feature icon={<Sparkles className="h-5 w-5" />} title="Active and Agile" body="Supports joint flexibility every day." />
            <Feature icon={<Check className="h-5 w-5" />} title="Simple Yet Effective" body="Unflavored — dissolves in hot or cold." />
          </div>
        </div>
      </section>

      {/* TESTIMONIALS */}
      <section className="py-24">
        <div className="mx-auto max-w-6xl px-6">
          <div className="mx-auto max-w-2xl text-center">
            <span className="text-xs font-semibold uppercase tracking-[0.25em] text-primary">
              Customer Stories
            </span>
            <h2
              className="mt-3 text-4xl font-semibold leading-tight md:text-5xl"
              style={{ fontFamily: "var(--font-display)" }}
            >
              Loved by thousands.
            </h2>
          </div>
          <div className="mt-14 grid gap-6 md:grid-cols-2">
            {reviews.map((r) => (
              <figure
                key={r.name}
                className="rounded-3xl border border-border bg-card p-8 shadow-soft"
              >
                <div className="mb-3 flex">
                  {[...Array(5)].map((_, i) => (
                    <Star key={i} className="h-4 w-4 fill-gold text-gold" />
                  ))}
                </div>
                <blockquote
                  className="text-lg leading-relaxed text-foreground"
                  style={{ fontFamily: "var(--font-display)" }}
                >
                  "{r.text}"
                </blockquote>
                <figcaption className="mt-5 text-sm font-semibold uppercase tracking-wider text-primary">
                  — {r.name}
                </figcaption>
              </figure>
            ))}
          </div>
        </div>
      </section>

      {/* DOCTOR */}
      <section className="bg-primary text-primary-foreground py-20">
        <div className="mx-auto max-w-4xl px-6 text-center">
          <span className="text-xs font-semibold uppercase tracking-[0.25em] text-primary-foreground/70">
            Formulated By
          </span>
          <h2
            className="mt-3 text-4xl font-semibold md:text-5xl"
            style={{ fontFamily: "var(--font-display)" }}
          >
            Dr. Frank Shallenberger
          </h2>
          <p className="mx-auto mt-6 max-w-2xl text-lg leading-relaxed text-primary-foreground/85">
            Editor-in-Chief of Second Opinion Newsletter, board-certified by the American
            Board of Anti-Aging Medicine, with over 44 years of practicing medicine.
          </p>
        </div>
      </section>

      {/* ORDER */}
      <section id="order" className="bg-cream py-24">
        <div className="mx-auto max-w-6xl px-6">
          <div className="mx-auto max-w-2xl text-center">
            <span className="text-xs font-semibold uppercase tracking-[0.25em] text-primary">
              Risk-Free Order
            </span>
            <h2
              className="mt-3 text-4xl font-semibold leading-tight md:text-5xl"
              style={{ fontFamily: "var(--font-display)" }}
            >
              Try Advanced Collagen Plus today.
            </h2>
            <p className="mt-4 text-muted-foreground">
              Backed by our 90-day money-back guarantee. Even if the bags are empty.
            </p>
          </div>

          <div className="mt-14 grid gap-6 md:grid-cols-3">
            {packages.map((p) => (
              <div
                key={p.bags}
                className={`relative flex flex-col rounded-3xl border bg-card p-8 shadow-soft transition hover:-translate-y-1 hover:shadow-elegant ${
                  p.highlight
                    ? "border-primary ring-2 ring-primary/30"
                    : "border-border"
                }`}
              >
                {p.highlight && (
                  <div className="absolute -top-3 left-1/2 -translate-x-1/2 rounded-full bg-primary px-4 py-1 text-xs font-semibold uppercase tracking-wider text-primary-foreground">
                    {p.label}
                  </div>
                )}
                {!p.highlight && (
                  <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                    {p.label}
                  </div>
                )}
                <div
                  className="mt-3 text-5xl font-semibold text-foreground"
                  style={{ fontFamily: "var(--font-display)" }}
                >
                  {p.bags}
                  <span className="ml-1 text-base font-medium text-muted-foreground">
                    Bag{p.bags > 1 ? "s" : ""}
                  </span>
                </div>
                <div className="mt-2 flex items-baseline gap-2">
                  <span className="text-3xl font-bold text-primary">${p.price}</span>
                  <span className="text-sm text-muted-foreground">/ bag</span>
                </div>

                <ul className="mt-6 space-y-3 text-sm">
                  {p.save > 0 && (
                    <li className="flex items-center gap-2 text-foreground">
                      <Check className="h-4 w-4 text-primary" /> Save ${p.save.toFixed(2)} instantly
                    </li>
                  )}
                  {p.freeShip && (
                    <li className="flex items-center gap-2 text-foreground">
                      <Truck className="h-4 w-4 text-primary" /> Free shipping included
                    </li>
                  )}
                  <li className="flex items-center gap-2 text-foreground">
                    <Shield className="h-4 w-4 text-primary" /> 90-day money-back guarantee
                  </li>
                </ul>

                <div className="mt-6 border-t border-border pt-4 text-sm text-muted-foreground">
                  Total
                  <span className="float-right text-lg font-bold text-foreground">
                    ${p.total.toFixed(2)}
                  </span>
                </div>

                <button
                  className={`mt-6 w-full rounded-full px-6 py-3.5 text-sm font-semibold transition ${
                    p.highlight
                      ? "bg-primary text-primary-foreground shadow-elegant hover:bg-primary-deep"
                      : "bg-foreground text-background hover:opacity-90"
                  }`}
                >
                  Add to Cart
                </button>
              </div>
            ))}
          </div>

          <div className="mt-10 flex flex-col items-center gap-4">
            <img src={paymentsImg} alt="Visa, Mastercard, American Express, Discover accepted" className="h-8" />
            <p className="text-xs text-muted-foreground">Secure checkout · SSL encrypted</p>
          </div>
        </div>
      </section>

      {/* GUARANTEE */}
      <section id="guarantee" className="py-20">
        <div className="mx-auto max-w-3xl rounded-3xl border border-primary/20 bg-card px-8 py-12 text-center shadow-elegant">
          <Shield className="mx-auto h-12 w-12 text-primary" />
          <h2
            className="mt-4 text-3xl font-semibold md:text-4xl"
            style={{ fontFamily: "var(--font-display)" }}
          >
            ABN™ 100% Satisfaction Guarantee
          </h2>
          <p className="mx-auto mt-4 max-w-xl text-muted-foreground">
            If you're unsatisfied for any reason, return it within 90 days for a full
            refund — even if the bags are empty. You only pay return shipping.
          </p>
        </div>
      </section>

      {/* FAQ */}
      <section id="faq" className="bg-cream py-24">
        <div className="mx-auto max-w-3xl px-6">
          <div className="text-center">
            <span className="text-xs font-semibold uppercase tracking-[0.25em] text-primary">
              FAQ
            </span>
            <h2
              className="mt-3 text-4xl font-semibold md:text-5xl"
              style={{ fontFamily: "var(--font-display)" }}
            >
              Frequently asked questions
            </h2>
          </div>
          <div className="mt-12 divide-y divide-border rounded-3xl border border-border bg-card">
            {faqs.map((f, i) => {
              const open = openFaq === i;
              return (
                <div key={f.q} className="px-6">
                  <button
                    onClick={() => setOpenFaq(open ? null : i)}
                    className="flex w-full items-center justify-between gap-4 py-5 text-left"
                  >
                    <span className="text-base font-semibold text-foreground">{f.q}</span>
                    {open ? (
                      <Minus className="h-5 w-5 shrink-0 text-primary" />
                    ) : (
                      <Plus className="h-5 w-5 shrink-0 text-primary" />
                    )}
                  </button>
                  {open && (
                    <p className="pb-5 text-muted-foreground leading-relaxed">{f.a}</p>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      </section>

      {/* FOOTER */}
      <footer className="border-t border-border bg-background py-12">
        <div className="mx-auto flex max-w-6xl flex-col items-center gap-4 px-6 text-center">
          <img src={logoImg} alt="Advanced Collagen Plus" className="h-10 w-auto" />
          <p className="text-sm text-muted-foreground">
            © {new Date().getFullYear()} Advanced Collagen Plus. All rights reserved.
          </p>
          <p className="max-w-2xl text-xs text-muted-foreground">
            These statements have not been evaluated by the FDA. This product is not
            intended to diagnose, treat, cure, or prevent any disease.
          </p>
        </div>
      </footer>
    </div>
  );
}

function Feature({ icon, title, body }: { icon: React.ReactNode; title: string; body: string }) {
  return (
    <div className="flex gap-4">
      <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
        {icon}
      </div>
      <div>
        <div className="font-semibold text-foreground">{title}</div>
        <div className="text-sm text-muted-foreground">{body}</div>
      </div>
    </div>
  );
}
