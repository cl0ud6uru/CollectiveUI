"use client"; // Error boundaries must be Client Components

/**
 * Last resort for an error in the root layout itself. It replaces the whole document, so it carries its own
 * html/body and inline styles (global styles and providers are not available here).
 */
export default function GlobalError({ retry }: { error: unknown; retry: () => void }) {
  return (
    <html lang="en">
      <body style={{ margin: 0, minHeight: "100vh", display: "grid", placeItems: "center", fontFamily: "system-ui, sans-serif", background: "Canvas", color: "CanvasText", colorScheme: "light dark" }}>
        <div role="alert" style={{ maxWidth: 420, padding: 24, textAlign: "center" }}>
          <h1 style={{ fontSize: 20, margin: "0 0 8px" }}>Something went wrong</h1>
          <p style={{ fontSize: 14, margin: "0 0 16px", opacity: 0.75 }}>The page could not be loaded. Try again in a moment.</p>
          <button type="button" onClick={() => retry()} style={{ font: "inherit", padding: "8px 16px", borderRadius: 999, border: "1px solid currentColor", background: "transparent", color: "inherit", cursor: "pointer" }}>
            Try again
          </button>
        </div>
      </body>
    </html>
  );
}
