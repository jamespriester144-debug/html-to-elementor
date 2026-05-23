const root = document.getElementById("root");

if (root) {
  root.innerHTML = `
    <main class="vite-shell">
      <section class="vite-hero">
        <div>
          <p style="letter-spacing:.2em;text-transform:uppercase;color:#fb7185;">Runtime Export</p>
          <h1 style="font-size:56px;line-height:1.05;margin:0 0 16px;">Vite/React rendered before capture</h1>
          <p style="font-size:20px;line-height:1.6;max-width:42ch;">The browser runtime mounts this page, so the universal pipeline must render first and only then analyze sections.</p>
          <a class="vite-cta" href="#checkout">Open checkout</a>
        </div>
        <img src="../common/hero.svg" alt="Rendered hero" style="width:100%;border-radius:32px;box-shadow:0 25px 60px rgba(15,23,42,0.18);" />
      </section>
    </main>
  `;
}
