import Link from "next/link";

import { StatusBadge } from "@/components/StatusBadge";
import { requireConversion } from "@/lib/conversions";

type PreviewPageProps = {
  params: Promise<{ id: string }>;
};

export default async function PreviewPage({ params }: PreviewPageProps) {
  const { id } = await params;
  const conversion = await requireConversion(id);
  const iframeId = `conversion-preview-frame-${conversion.id}`;

  return (
    <main className="w-full px-4 py-8 sm:px-6 xl:px-8">
      <div className="mb-6 flex flex-wrap items-center justify-between gap-4">
        <div>
          <p className="text-sm font-semibold uppercase tracking-wide text-coral">
            Previa do site Lovable
          </p>
          <h1 className="mt-2 text-3xl font-semibold tracking-tight text-ink">
            {conversion.elementor_json.title}
          </h1>
          <p className="mt-2 max-w-3xl text-sm text-ink/70">
            O preview abaixo usa scroll proprio e mantem a largura desktop do site para evitar
            cortes ou compressao excessiva do layout.
          </p>
        </div>
        <StatusBadge status={conversion.status} />
      </div>

      <section className="rounded-2xl border border-ink/15 bg-white/70 shadow-soft">
        <div className="border-b border-ink/10 px-4 py-3 text-xs font-medium uppercase tracking-[0.18em] text-ink/55">
          Preview completo com scroll
        </div>
        <div className="h-[calc(100vh-18rem)] min-h-[720px] overflow-auto overscroll-contain">
          <iframe
            className="block min-h-full w-[max(100%,1440px)] border-0 bg-white"
            id={iframeId}
            scrolling="auto"
            sandbox="allow-same-origin"
            srcDoc={conversion.html}
            title="Previa do site convertido"
          />
        </div>
      </section>
      <script
        dangerouslySetInnerHTML={{
          __html: `(function(){
  var frame = document.getElementById(${JSON.stringify(iframeId)});
  if (!frame) return;
  function applyHeight(nextHeight) {
    if (!nextHeight || !Number.isFinite(nextHeight)) return;
    var targetHeight = Math.ceil(nextHeight);
    var currentHeight = Math.ceil(parseFloat(frame.style.height || "0"));
    if (Math.abs(targetHeight - currentHeight) <= 1) return;
    frame.style.height = String(targetHeight) + "px";
  }
  function resizeFromDocument() {
    try {
      var doc = frame.contentDocument || frame.contentWindow.document;
      if (!doc) return;
      var body = doc.body;
      var root = doc.documentElement;
      var bodyRectHeight = body ? Math.ceil(body.getBoundingClientRect().height) : 0;
      var rootRectHeight = root ? Math.ceil(root.getBoundingClientRect().height) : 0;
      applyHeight(Math.max(
        body ? body.scrollHeight : 0,
        root ? root.scrollHeight : 0,
        body ? body.offsetHeight : 0,
        root ? root.offsetHeight : 0,
        body ? body.clientHeight : 0,
        root ? root.clientHeight : 0,
        bodyRectHeight,
        rootRectHeight
      ));
    } catch (error) {}
  }
  function handleMessage(event) {
    var data = event && event.data;
    if (!data || data.type !== "html-to-elementor:frame-resize") return;
    applyHeight(Number(data.height));
  }
  window.addEventListener("message", handleMessage);
  frame.addEventListener("load", resizeFromDocument);
  setTimeout(resizeFromDocument, 50);
  setTimeout(resizeFromDocument, 250);
  setTimeout(resizeFromDocument, 1000);
  setTimeout(resizeFromDocument, 2500);
})();`
        }}
      />

      <div className="mt-6 flex flex-wrap gap-3">
        <Link
          className="rounded-lg bg-moss px-5 py-3 text-sm font-semibold text-white transition hover:bg-moss/90"
          href={`/checkout/${conversion.id}`}
        >
          Liberar template Elementor
        </Link>
      </div>
    </main>
  );
}
