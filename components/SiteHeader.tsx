import Link from "next/link";

export function SiteHeader() {
  return (
    <header className="border-b border-ink/10 bg-paper/90 backdrop-blur">
      <div className="mx-auto flex max-w-6xl items-center justify-between px-5 py-4">
        <Link className="text-lg font-semibold tracking-tight text-ink" href="/">
          html-to-elementor
        </Link>
        <nav className="flex items-center gap-4 text-sm text-ink/70">
          <Link className="hover:text-ink" href="/upload">
            Upload
          </Link>
        </nav>
      </div>
    </header>
  );
}
