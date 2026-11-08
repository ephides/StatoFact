import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import { CITree } from "@/app/ci-tree";
import "./globals.css";

export const metadata: Metadata = {
  title: "StatoFact CMDB",
  description: "Einfache CMDB auf Basis von ArcadeDB",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="de">
      <body>
        <header className="site">
          <Link href="/">
            <Image
              src="/statofact-logo.png"
              alt="StatoFact CMDB"
              width={1774}
              height={887}
              className="site-logo"
            />
          </Link>
          <Link href="/jobs">Jobs</Link>
        </header>
        <div className="app-layout">
          <aside className="ci-sidebar">
            <h2>Configuration Items</h2>
            <CITree />
          </aside>
          <main>{children}</main>
        </div>
      </body>
    </html>
  );
}
